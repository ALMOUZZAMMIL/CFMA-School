'use strict';
// Loads the school's own data (calendar, timetable, yearly programmes) from the JSON files in
// school-data/ into the database. Running it again updates what it loaded before instead of
// adding duplicates, so a corrected file can simply be imported again.
//
// Teacher names never live in the repository: the timetable uses codes (T01, T02...). A private
// file that maps codes to real names can be given; without it, accounts are named "Teacher T01".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const { minutesBetween } = require('./util');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Reads every file of a school-data folder. Missing parts are simply skipped.
function loadFolder(dir, { teachersFile } = {}) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const pick = (prefix) => files.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort().map((f) => readJson(path.join(dir, f)));
  const progDir = path.join(dir, 'programmes');
  const programmes = fs.existsSync(progDir)
    ? fs.readdirSync(progDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, ...readJson(path.join(progDir, f)) }))
    : [];
  return {
    calendars: pick('calendar-'),
    timetables: pick('timetable-'),
    programmes,
    teacherNames: teachersFile && fs.existsSync(teachersFile) ? readJson(teachersFile).teachers || {} : {},
  };
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

function importAll(d, data, { log = () => {} } = {}) {
  const stats = { years: 0, terms: 0, closures: 0, events: 0, sections: 0, subjects: 0, classes: 0, teachers: 0, assignments: 0, slots: 0, plans: 0, plansSkipped: 0, lessons: 0 };
  const run = d.transaction(() => {
    let yearId = null;
    for (const cal of data.calendars) yearId = importCalendar(d, cal, stats);
    if (!yearId) {
      const cur = d.prepare('SELECT id FROM academic_years WHERE is_current = 1').get();
      if (!cur) throw new Error('No calendar file and no current school year: add a calendar-YYYY-YYYY.json file first.');
      yearId = cur.id;
    }
    for (const tt of data.timetables) importTimetable(d, tt, yearId, data.teacherNames, stats);
    for (const p of data.programmes) importProgramme(d, p, yearId, stats, log);
  });
  run();
  return stats;
}

function importCalendar(d, cal, stats) {
  const y = cal.year;
  let year = d.prepare('SELECT * FROM academic_years WHERE name = ?').get(y.name);
  if (year) d.prepare('UPDATE academic_years SET start_date = ?, end_date = ? WHERE id = ?').run(y.start_date, y.end_date, year.id);
  else {
    const hasCurrent = d.prepare('SELECT 1 FROM academic_years WHERE is_current = 1').get();
    const id = d.prepare('INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES (?, ?, ?, ?)').run(y.name, y.start_date, y.end_date, hasCurrent ? 0 : 1).lastInsertRowid;
    year = { id: Number(id) };
    stats.years++;
  }
  for (const t of cal.terms || []) {
    const ex = d.prepare('SELECT id FROM terms WHERE year_id = ? AND ordinal = ?').get(year.id, t.ordinal);
    if (ex) d.prepare('UPDATE terms SET name = ?, start_date = ?, end_date = ? WHERE id = ?').run(t.name, t.start_date, t.end_date, ex.id);
    else { d.prepare('INSERT INTO terms (year_id, name, ordinal, start_date, end_date) VALUES (?, ?, ?, ?, ?)').run(year.id, t.name, t.ordinal, t.start_date, t.end_date); stats.terms++; }
  }
  for (const c of cal.closures || []) {
    const reason = `${c.reason_fr} / ${c.reason_en}`;
    if (!d.prepare('SELECT 1 FROM closures WHERE year_id = ? AND start_date = ? AND end_date = ?').get(year.id, c.start_date, c.end_date)) {
      d.prepare('INSERT INTO closures (year_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)').run(year.id, c.start_date, c.end_date, reason);
      stats.closures++;
    }
  }
  // The calendar file is the source of truth for the year's events: replace them as a whole.
  if (cal.events) {
    d.prepare('DELETE FROM school_events WHERE year_id = ?').run(year.id);
    const ins = d.prepare(`INSERT INTO school_events (year_id, start_date, end_date, category, title_fr, title_en, audience_fr, audience_en, venue, note)
      VALUES (@year_id, @start_date, @end_date, @category, @title_fr, @title_en, @audience_fr, @audience_en, @venue, @note)`);
    for (const e of cal.events) {
      ins.run({ year_id: year.id, start_date: e.start_date, end_date: e.end_date || e.start_date, category: e.category || 'other', title_fr: e.title_fr, title_en: e.title_en, audience_fr: e.audience_fr || null, audience_en: e.audience_en || null, venue: e.venue || null, note: e.check || null });
      stats.events++;
    }
  }
  return year.id;
}

function upsertSection(d, s, stats) {
  const ex = d.prepare('SELECT id FROM sections WHERE code = ?').get(s.code);
  if (ex) return ex.id;
  stats.sections++;
  return Number(d.prepare('INSERT INTO sections (code, name_fr, name_en) VALUES (?, ?, ?)').run(s.code, s.name_fr, s.name_en).lastInsertRowid);
}

function upsertSubject(d, s, stats) {
  const ex = d.prepare('SELECT id FROM subjects WHERE code = ?').get(s.code);
  if (ex) return ex.id;
  stats.subjects++;
  return Number(d.prepare('INSERT INTO subjects (code, name_fr, name_en) VALUES (?, ?, ?)').run(s.code, s.name_fr, s.name_en).lastInsertRowid);
}

// Consecutive periods with no break between them become one lesson (a "double period").
function mergePeriods(nums, periods) {
  const byN = new Map(periods.map((p) => [p.n, p]));
  const blocks = [];
  for (const n of [...nums].sort((a, b) => a - b)) {
    const p = byN.get(n);
    if (!p) throw new Error(`Unknown period ${n}`);
    const last = blocks[blocks.length - 1];
    if (last && last.end === p.start) last.end = p.end;
    else blocks.push({ start: p.start, end: p.end });
  }
  return blocks;
}

function importTimetable(d, tt, yearId, names, stats) {
  // The bell schedule lets the timetable page draw the week as a grid of periods.
  if (tt.periods) d.prepare("INSERT INTO settings (key, value) VALUES ('bell_schedule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(tt.periods));
  const sectionIds = {};
  for (const s of tt.sections || []) sectionIds[s.code] = upsertSection(d, s, stats);
  const subjectIds = {};
  for (const s of tt.subjects || []) subjectIds[s.code] = upsertSubject(d, s, stats);
  const classIds = {};
  for (const c of tt.classes || []) {
    const ex = d.prepare('SELECT id FROM classes WHERE year_id = ? AND name = ?').get(yearId, c.name);
    if (ex) classIds[c.name] = ex.id;
    else {
      const sid = sectionIds[c.section] || (d.prepare('SELECT id FROM sections WHERE code = ?').get(c.section) || {}).id;
      if (!sid) throw new Error(`Unknown section ${c.section} for class ${c.name}`);
      classIds[c.name] = Number(d.prepare('INSERT INTO classes (year_id, section_id, level, name) VALUES (?, ?, ?, ?)').run(yearId, sid, c.level, c.name).lastInsertRowid);
      stats.classes++;
    }
  }
  const teacherIds = {};
  for (const t of tt.teachers || []) {
    // Accounts are found again by their import code (kept in the username), so names can change.
    const realName = names[t.code];
    const username = realName ? `${slug(realName)}.${t.code.toLowerCase()}` : `prof.${t.code.toLowerCase()}`;
    const ex = d.prepare("SELECT id FROM users WHERE role = 'teacher' AND (username = ? OR username LIKE ?)").get(username, `%.${t.code.toLowerCase()}`);
    if (ex) {
      if (realName) d.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(realName, ex.id);
      teacherIds[t.code] = ex.id;
    } else {
      // New accounts start switched off with an unknown password: the administrator turns each
      // one on and gives the teacher a password from Administration > Accounts.
      const pw = auth.hashPassword(crypto.randomBytes(18).toString('base64'));
      teacherIds[t.code] = Number(d.prepare("INSERT INTO users (username, password_hash, full_name, role, language, active, must_change_password) VALUES (?, ?, ?, 'teacher', ?, 0, 1)")
        .run(username, pw, realName || `Enseignant ${t.code}`, t.language || 'fr').lastInsertRowid);
      stats.teachers++;
    }
  }
  const terms = d.prepare('SELECT id FROM terms WHERE year_id = ? ORDER BY ordinal').all(yearId);
  if (!terms.length) throw new Error('The school year has no terms: import the calendar first.');
  const findA = d.prepare('SELECT id FROM teaching_assignments WHERE teacher_id = ? AND class_id = ? AND subject_id = ?');
  const insA = d.prepare('INSERT INTO teaching_assignments (teacher_id, class_id, subject_id) VALUES (?, ?, ?)');
  const findS = d.prepare('SELECT 1 FROM timetable_slots WHERE assignment_id = ? AND term_id = ? AND day_of_week = ? AND start_time = ?');
  const insS = d.prepare('INSERT INTO timetable_slots (assignment_id, term_id, day_of_week, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, NULL)');
  for (const e of tt.entries || []) {
    const teacher = teacherIds[e.teacher];
    const subject = subjectIds[e.subject] || (d.prepare('SELECT id FROM subjects WHERE code = ?').get(e.subject) || {}).id;
    if (!teacher || !subject) throw new Error(`Timetable entry with unknown teacher or subject: ${JSON.stringify(e)}`);
    for (const cname of e.classes) {
      const cls = classIds[cname];
      if (!cls) throw new Error(`Timetable entry with unknown class "${cname}"`);
      let a = findA.get(teacher, cls, subject);
      if (!a) { a = { id: Number(insA.run(teacher, cls, subject).lastInsertRowid) }; stats.assignments++; }
      for (const b of mergePeriods(e.periods, tt.periods)) {
        if (minutesBetween(b.start, b.end) <= 0) continue;
        for (const term of terms) {
          if (findS.get(a.id, term.id, e.day, b.start)) continue;
          insS.run(a.id, term.id, e.day, b.start, b.end);
          stats.slots++;
        }
      }
    }
  }
}

function importProgramme(d, p, yearId, stats, log) {
  const section = d.prepare('SELECT id FROM sections WHERE code = ?').get(p.section);
  const sectionId = section ? section.id : upsertSection(d, { code: p.section, name_fr: p.section, name_en: p.section }, stats);
  const subjectId = upsertSubject(d, { code: p.subject, name_fr: p.subject_fr || p.subject, name_en: p.subject_en || p.subject }, stats);
  const terms = d.prepare('SELECT id, ordinal FROM terms WHERE year_id = ?').all(yearId);
  const termId = (n) => (terms.find((t) => t.ordinal === n) || {}).id || null;
  let plan = d.prepare('SELECT id FROM plans WHERE year_id = ? AND section_id = ? AND level = ? AND subject_id = ?').get(yearId, sectionId, p.level, subjectId);
  if (plan) {
    // Never rewrite a programme teachers have already recorded progress against.
    const used = d.prepare(`SELECT 1 FROM progress_entries pe JOIN plan_lessons l ON l.id = pe.lesson_id JOIN plan_chapters c ON c.id = l.chapter_id
      WHERE c.plan_id = ? LIMIT 1`).get(plan.id);
    if (used) { stats.plansSkipped++; log(`Skipped ${p.file}: lessons already have recorded progress.`); return; }
    d.prepare('DELETE FROM plan_chapters WHERE plan_id = ?').run(plan.id);
    d.prepare('UPDATE plans SET title = ? WHERE id = ?').run(p.title, plan.id);
  } else {
    plan = { id: Number(d.prepare('INSERT INTO plans (year_id, section_id, level, subject_id, title) VALUES (?, ?, ?, ?, ?)').run(yearId, sectionId, p.level, subjectId, p.title).lastInsertRowid) };
  }
  stats.plans++;
  const insC = d.prepare('INSERT INTO plan_chapters (plan_id, term_id, ordinal, title) VALUES (?, ?, ?, ?)');
  const insL = d.prepare('INSERT INTO plan_lessons (chapter_id, ordinal, title, planned_date, planned_hours) VALUES (?, ?, ?, ?, ?)');
  (p.chapters || []).forEach((c, ci) => {
    const cid = Number(insC.run(plan.id, termId(c.term), ci + 1, c.title).lastInsertRowid);
    (c.lessons || []).forEach((l, li) => {
      const lesson = typeof l === 'string' ? { title: l } : l;
      insL.run(cid, li + 1, lesson.title, lesson.date || null, lesson.hours || null);
      stats.lessons++;
    });
  });
}

module.exports = { loadFolder, importAll, mergePeriods };
