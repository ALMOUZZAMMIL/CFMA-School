'use strict';
// Loads clearly labelled DEMONSTRATION data. All people and records are fictional.
// Usage: npm run seed            (only on an empty database)
//        npm run seed -- --reset  (deletes the database file first)
const fs = require('fs');
const path = require('path');

const reset = process.argv.includes('--reset');
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db');
if (reset) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);

const db = require('../src/db');
const auth = require('../src/auth');
const { addDays, weekday, todayIn, minutesBetween } = require('../src/util');

db.open(dbFile);
const d = db.get();
if (d.prepare('SELECT COUNT(*) n FROM users').get().n > 0) {
  console.error('The database already has accounts. Demo data is only loaded into an empty database.\nUse "npm run seed -- --reset" to delete everything and start again with demo data.');
  process.exit(1);
}

// Deterministic pseudo-random numbers so the demo looks the same every time.
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const DEMO_PASSWORD = 'demo-password';
const pw = auth.hashPassword(DEMO_PASSWORD);

d.transaction(() => {
  // School identity from the school's own 2026-2027 flyer. Student, staff and parent data stay fictional.
  db.setSetting('school_name', 'Collège Bilingue Maloum & Ayena');
  db.setSetting('school_motto', 'Discipline · Savoir · Réussite — Discipline · Knowledge · Success');
  db.setSetting('school_address', 'BP 903 Yaoundé, Cameroun — Etoudi (ancien 6e route Nkolmbong)');
  db.setSetting('school_phone', '+237 680 90 06 75');
  db.setSetting('school_email', 'maloumayena@gmail.com');
  db.setSetting('demo_mode', '1');

  const year = Number(d.prepare("INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-07', '2027-06-30', 1)").run().lastInsertRowid);
  const term = (name, ord, s, e) => Number(d.prepare('INSERT INTO terms (year_id, name, ordinal, start_date, end_date) VALUES (?, ?, ?, ?, ?)').run(year, name, ord, s, e).lastInsertRowid);
  const t1 = term('Trimestre 1 / Term 1', 1, '2026-09-07', '2026-12-18');
  const t2 = term('Trimestre 2 / Term 2', 2, '2027-01-05', '2027-03-26');
  const t3 = term('Trimestre 3 / Term 3', 3, '2027-04-06', '2027-06-30');
  d.prepare('INSERT INTO closures (year_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)').run(year, '2026-10-29', '2026-10-30', 'Congé de mi-trimestre (démo) / Mid-term break (demo)');
  d.prepare('INSERT INTO closures (year_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)').run(year, '2027-05-20', '2027-05-20', 'Jour férié (démo) / Public holiday (demo)');

  const section = (code, fr, en) => Number(d.prepare('INSERT INTO sections (code, name_fr, name_en) VALUES (?, ?, ?)').run(code, fr, en).lastInsertRowid);
  const GEN = section('GEN', 'Enseignement général', 'General');
  const TECH = section('TECH', 'Enseignement technique', 'Technical');
  const ANG = section('ANG', 'Sous-système anglophone', 'Anglophone');

  const subject = (code, fr, en) => Number(d.prepare('INSERT INTO subjects (code, name_fr, name_en) VALUES (?, ?, ?)').run(code, fr, en).lastInsertRowid);
  const MATH = subject('MATH', 'Mathématiques', 'Mathematics');
  const FRAN = subject('FRAN', 'Français', 'French');
  const ENG = subject('ANGL', 'Anglais', 'English Language');
  const PHYS = subject('PCT', 'Physique-Chimie', 'Physics and Chemistry');
  const ELEC = subject('ELEC', 'Électrotechnique', 'Electrical Technology');
  const HIST = subject('HG', 'Histoire-Géographie', 'History and Geography');

  const cls = (sec, level, name) => Number(d.prepare('INSERT INTO classes (year_id, section_id, level, name) VALUES (?, ?, ?, ?)').run(year, sec, level, name).lastInsertRowid);
  const c2C = cls(GEN, 'Seconde C', '2nde C');
  const c1F3 = cls(TECH, 'Première F3', '1ère F3');
  const cF4 = cls(ANG, 'Form 4', 'Form 4 A');

  const user = (username, name, role, lang, phone) => Number(d.prepare('INSERT INTO users (username, password_hash, full_name, role, language, phone, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 0)').run(username, pw, name, role, lang, phone || null).lastInsertRowid);
  const admin = user('demo.admin', 'Admin DÉMO', 'admin', 'fr');
  const tMath = user('demo.prof.maths', 'M. Prof-Maths DÉMO', 'teacher', 'fr');
  const tLang = user('demo.prof.lettres', 'Mme Prof-Lettres DÉMO', 'teacher', 'fr');
  const tTech = user('demo.prof.tech', 'M. Prof-Tech DÉMO', 'teacher', 'fr');
  const tEng = user('demo.teacher.eng', 'Mrs Teacher-English DEMO', 'teacher', 'en');
  user('demo.intendant', 'Intendant DÉMO', 'bursar', 'fr');

  const assign = (tid, cid, sid) => Number(d.prepare('INSERT INTO teaching_assignments (teacher_id, class_id, subject_id) VALUES (?, ?, ?)').run(tid, cid, sid).lastInsertRowid);
  const slot = (aid, dow, s, e, room) => { for (const tm of [t1, t2, t3]) d.prepare('INSERT INTO timetable_slots (assignment_id, term_id, day_of_week, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?)').run(aid, tm, dow, s, e, room); };

  const A = {
    math2C: assign(tMath, c2C, MATH), fr2C: assign(tLang, c2C, FRAN), phys2C: assign(tMath, c2C, PHYS),
    math1F3: assign(tMath, c1F3, MATH), elec1F3: assign(tTech, c1F3, ELEC), fr1F3: assign(tLang, c1F3, FRAN),
    mathF4: assign(tEng, cF4, MATH), engF4: assign(tEng, cF4, ENG), histF4: assign(tLang, cF4, HIST),
  };
  slot(A.math2C, 1, '07:30', '09:30', 'S12'); slot(A.math2C, 4, '10:00', '12:00', 'S12');
  slot(A.fr2C, 2, '07:30', '09:30', 'S12'); slot(A.fr2C, 5, '10:00', '11:00', 'S12');
  slot(A.phys2C, 3, '07:30', '09:30', 'Labo');
  slot(A.math1F3, 2, '10:00', '12:00', 'A3'); slot(A.math1F3, 5, '07:30', '09:30', 'A3');
  slot(A.elec1F3, 1, '10:00', '13:00', 'Atelier'); slot(A.elec1F3, 3, '13:00', '15:00', 'Atelier');
  slot(A.fr1F3, 4, '07:30', '09:30', 'A3');
  slot(A.mathF4, 1, '07:30', '09:30', 'B5'); slot(A.mathF4, 3, '10:00', '12:00', 'B5');
  slot(A.engF4, 2, '13:00', '15:00', 'B5'); slot(A.engF4, 4, '13:00', '14:00', 'B5');
  slot(A.histF4, 5, '13:00', '15:00', 'B5');

  // Students: clearly fictional "DEMO" names.
  const first = ['Aïcha', 'Brice', 'Clarisse', 'Daniel', 'Estelle', 'Franck', 'Grâce', 'Hervé', 'Inès', 'Joël', 'Kevin', 'Laure'];
  const firstEn = ['Abigail', 'Bright', 'Comfort', 'Divine', 'Emmanuel', 'Faith', 'Gideon', 'Hope', 'Ivan', 'Joy', 'Kelly', 'Lionel'];
  let num = 1;
  const students = {};
  for (const [cid, names] of [[c2C, first], [c1F3, first.slice(0, 10)], [cF4, firstEn]]) {
    students[cid] = names.map((n) => {
      const id = Number(d.prepare('INSERT INTO students (student_number, full_name, is_demo) VALUES (?, ?, 1)').run(`DEMO${String(num).padStart(3, '0')}`, `${n} DEMO-${String(num).padStart(2, '0')}`).lastInsertRowid);
      num++;
      d.prepare('INSERT INTO enrollments (student_id, class_id) VALUES (?, ?)').run(id, cid);
      return id;
    });
  }
  // A student login and two parent logins.
  const sUser = user('demo.eleve', students[c2C][0] && d.prepare('SELECT full_name FROM students WHERE id = ?').get(students[c2C][0]).full_name, 'student', 'fr');
  d.prepare('UPDATE students SET user_id = ? WHERE id = ?').run(sUser, students[c2C][0]);
  const p1 = user('demo.parent', 'Parent DÉMO 1', 'parent', 'fr', '+237 600 000 001');
  const p2 = user('demo.parent.en', 'Parent DEMO 2', 'parent', 'en', '+237 600 000 002');
  d.prepare('INSERT INTO guardians (parent_user_id, student_id, relationship) VALUES (?, ?, ?)').run(p1, students[c2C][0], 'Mère / Mother');
  d.prepare('INSERT INTO guardians (parent_user_id, student_id, relationship) VALUES (?, ?, ?)').run(p1, students[c1F3][3], 'Mère / Mother');
  d.prepare('INSERT INTO guardians (parent_user_id, student_id, relationship) VALUES (?, ?, ?)').run(p2, students[cF4][1], 'Father');

  // Yearly plans (illustrative only, NOT the official curriculum).
  const plan = (sec, level, sub, title, chapters) => {
    const pid = Number(d.prepare('INSERT INTO plans (year_id, section_id, level, subject_id, title, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(year, sec, level, sub, title, admin).lastInsertRowid);
    let date = '2026-09-14';
    chapters.forEach(([chTitle, lessons, termId], ci) => {
      const cid = Number(d.prepare('INSERT INTO plan_chapters (plan_id, term_id, ordinal, title) VALUES (?, ?, ?, ?)').run(pid, termId, ci + 1, chTitle).lastInsertRowid);
      lessons.forEach((l, li) => {
        d.prepare('INSERT INTO plan_lessons (chapter_id, ordinal, title, planned_date, planned_hours) VALUES (?, ?, ?, ?, ?)').run(cid, li + 1, l, date, 2);
        date = addDays(date, 7);
      });
    });
    return pid;
  };
  const demoChapters = (prefix, en) => [
    [`${prefix} 1 (${en ? 'demo' : 'démo'})`, [1, 2, 3].map((i) => `${en ? 'Lesson' : 'Leçon'} 1.${i}`), t1],
    [`${prefix} 2 (${en ? 'demo' : 'démo'})`, [1, 2, 3, 4].map((i) => `${en ? 'Lesson' : 'Leçon'} 2.${i}`), t1],
    [`${prefix} 3 (${en ? 'demo' : 'démo'})`, [1, 2, 3].map((i) => `${en ? 'Lesson' : 'Leçon'} 3.${i}`), t1],
    [`${prefix} 4 (${en ? 'demo' : 'démo'})`, [1, 2, 3, 4].map((i) => `${en ? 'Lesson' : 'Leçon'} 4.${i}`), t2],
    [`${prefix} 5 (${en ? 'demo' : 'démo'})`, [1, 2, 3].map((i) => `${en ? 'Lesson' : 'Leçon'} 5.${i}`), t3],
  ];
  plan(GEN, 'Seconde C', MATH, 'Mathématiques — Seconde C (exemple)', demoChapters('Chapitre', false));
  plan(GEN, 'Seconde C', FRAN, 'Français — Seconde C (exemple)', demoChapters('Séquence', false));
  plan(TECH, 'Première F3', ELEC, 'Électrotechnique — Première F3 (exemple)', demoChapters('Module', false));
  plan(TECH, 'Première F3', MATH, 'Mathématiques — Première F3 (exemple)', demoChapters('Chapitre', false));
  plan(ANG, 'Form 4', MATH, 'Mathematics — Form 4 (example)', demoChapters('Topic', true));
  plan(ANG, 'Form 4', ENG, 'English Language — Form 4 (example)', demoChapters('Unit', true));

  // Recorded lessons and attendance from the start of term until yesterday.
  const today = todayIn('Africa/Douala');
  const end = addDays(today, -1);
  const closures = d.prepare('SELECT start_date, end_date FROM closures').all();
  const closed = (dt) => closures.some((c) => dt >= c.start_date && dt <= c.end_date);
  const slots = d.prepare('SELECT ts.*, ta.teacher_id, ta.class_id FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id WHERE ts.term_id = ?').all(t1);
  const insSession = d.prepare(`INSERT INTO class_sessions (assignment_id, slot_id, date, start_time, end_time, status, reason, makeup_status, makeup_planned_date, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const missed = [];
  for (let dt = '2026-09-07'; dt <= end && dt <= '2026-12-18'; dt = addDays(dt, 1)) {
    if (closed(dt)) continue;
    for (const s of slots.filter((x) => x.day_of_week === weekday(dt))) {
      const r = rand();
      if (r < 0.06 && dt > addDays(end, -10)) continue; // a few recent lessons not yet recorded
      if (r < 0.10) {
        const id = Number(insSession.run(s.assignment_id, s.id, dt, s.start_time, s.end_time, 'missed', 'Maladie (démo) / Illness (demo)', 'planned', addDays(dt, 5), s.teacher_id).lastInsertRowid);
        missed.push({ id, s, dt });
      } else if (r < 0.13) {
        insSession.run(s.assignment_id, s.id, dt, s.start_time, s.end_time, 'cancelled', 'Activité de l’établissement (démo) / School event (demo)', 'not_needed', null, admin);
      } else {
        insSession.run(s.assignment_id, s.id, dt, s.start_time, s.end_time, 'held', null, 'none', null, s.teacher_id);
      }
    }
    // Daily attendance for each class.
    if (weekday(dt) <= 5) {
      for (const cid of [c2C, c1F3, cF4]) {
        for (const sid of students[cid]) {
          const r = rand();
          const st = r < 0.86 ? 'present' : r < 0.93 ? 'absent' : r < 0.98 ? 'late' : 'excused';
          d.prepare('INSERT INTO attendance_records (class_id, student_id, date, status, recorded_by) VALUES (?, ?, ?, ?, ?)').run(cid, sid, dt, st, admin);
        }
      }
    }
  }
  // Half of the missed lessons have been made up.
  missed.filter((_, i) => i % 2 === 0).forEach((m) => {
    const md = addDays(m.dt, 5);
    if (md > end) return;
    d.prepare(`INSERT INTO class_sessions (assignment_id, date, start_time, end_time, status, makeup_for_session_id, recorded_by, notes)
      VALUES (?, ?, '15:00', ?, 'makeup', ?, ?, 'Rattrapage (démo)')`).run(m.s.assignment_id, md, (() => { const mins = minutesBetween(m.s.start_time, m.s.end_time); const h = 15 + Math.floor(mins / 60); return `${String(h).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; })(), m.id, m.s.teacher_id);
    d.prepare("UPDATE class_sessions SET makeup_status = 'completed' WHERE id = ?").run(m.id);
  });

  // Lesson progress: most classes slightly behind or on plan.
  const lessonsFor = d.prepare(`SELECT l.* FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id JOIN plans p ON p.id = ch.plan_id
    WHERE p.section_id = ? AND p.level = ? AND p.subject_id = ? ORDER BY ch.ordinal, l.ordinal`);
  const asg = d.prepare('SELECT ta.*, c.section_id, c.level FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id').all();
  for (const a of asg) {
    const lessons = lessonsFor.all(a.section_id, a.level, a.subject_id);
    const lag = Math.floor(rand() * 3); // 0-2 lessons behind
    const due = lessons.filter((l) => l.planned_date <= end);
    due.slice(0, Math.max(0, due.length - lag)).forEach((l) => {
      d.prepare('INSERT INTO progress_entries (assignment_id, lesson_id, date, status, recorded_by) VALUES (?, ?, ?, ?, ?)').run(a.id, l.id, addDays(l.planned_date, Math.floor(rand() * 3)) > end ? end : addDays(l.planned_date, Math.floor(rand() * 3)), 'completed', a.teacher_id);
    });
    const next = due[Math.max(0, due.length - lag)];
    if (next && lag > 0) d.prepare('INSERT INTO progress_entries (assignment_id, lesson_id, date, status, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, next.id, end, lag > 1 ? 'delayed' : 'in_progress', lag > 1 ? 'Cours manqués à rattraper (démo)' : null, a.teacher_id);
  }

  // Announcements.
  const ann = (cat, tfr, bfr, ten, ben, audience, classId, publishAt) => d.prepare(`INSERT INTO announcements (category, title_fr, body_fr, title_en, body_en, audience, class_id, publish_at, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`).run(cat, tfr, bfr, ten, ben, audience, classId, publishAt, admin);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  ann('meeting', 'Réunion parents-enseignants (démo)', 'Une réunion parents-enseignants aura lieu samedi à 9 h dans la grande salle. (Annonce de démonstration.)',
    'Parent-teacher meeting (demo)', 'A parent-teacher meeting will take place on Saturday at 9 a.m. in the main hall. (Demonstration notice.)', 'teacher,student,parent', null, now);
  ann('exam', 'Devoirs surveillés du 1er trimestre (démo)', 'Les devoirs surveillés commencent la semaine prochaine. Le calendrier détaillé sera affiché. (Annonce de démonstration.)',
    'Term 1 tests (demo)', 'Supervised tests start next week. The detailed timetable will be posted. (Demonstration notice.)', 'teacher,student,parent', null, now);
  ann('notice', 'Conseil pédagogique (démo)', 'Les enseignants sont invités au conseil pédagogique mercredi à 15 h. (Annonce de démonstration.)',
    null, null, 'teacher', null, now);
  ann('deadline', null, null, 'Form 4 A: project deadline (demo)', 'Form 4 A projects must be handed in by Friday. (Demonstration notice.)', 'student,parent', cF4, now);
})();

console.log(`
Demo data loaded (all fictional). Accounts — password for all: ${DEMO_PASSWORD}
  demo.admin            Administrator
  demo.prof.maths       Teacher (2nde C, 1ère F3)
  demo.prof.lettres     Teacher
  demo.prof.tech        Teacher (Technical section)
  demo.teacher.eng      Teacher (Anglophone section)
  demo.parent           Parent of two children
  demo.parent.en        Parent (English)
  demo.eleve            Student
  demo.intendant        Bursar (finance module not yet built)
Never use these accounts or this password on a real installation.
`);
