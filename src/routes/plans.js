'use strict';
// Yearly plans (programmes) by section, level and subject: chapters and lessons.
// Nothing about the national curriculum is hard-coded: the school enters or imports it.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { Validator, int, str, isDate, parseCsv } = require('../util');

const r = express.Router();

function lists(yearId) {
  return {
    sections: db.get().prepare('SELECT * FROM sections ORDER BY id').all(),
    subjects: db.get().prepare('SELECT * FROM subjects WHERE active = 1 ORDER BY name_en').all(),
    levels: db.get().prepare('SELECT DISTINCT section_id, level FROM classes WHERE year_id = ? ORDER BY level').all(yearId),
    terms: db.get().prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(yearId),
  };
}

r.get('/plans', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const sectionId = int(req.query.section);
  const rows = db.get().prepare(`SELECT p.*, se.name_en AS section_en, se.name_fr AS section_fr, s.name_en AS subject_en, s.name_fr AS subject_fr,
      (SELECT COUNT(*) FROM plan_chapters ch WHERE ch.plan_id = p.id) AS chapters,
      (SELECT COUNT(*) FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = p.id) AS lessons
    FROM plans p JOIN sections se ON se.id = p.section_id JOIN subjects s ON s.id = p.subject_id
    WHERE p.year_id = ? AND (? IS NULL OR p.section_id = ?) ORDER BY se.id, p.level, s.name_en`).all(year.id, sectionId, sectionId);
  res.render('plans/list', { title: req.t('plans.title'), rows, sectionId, ...lists(year.id), errors: [], values: {} });
});

r.post('/plans', auth.requireRole('admin'), (req, res) => {
  const year = res.locals.year;
  const values = { section_id: int(req.body.section_id), level: str(req.body.level, 60), subject_id: int(req.body.subject_id), title: str(req.body.title, 200) };
  const v = new Validator().required(values.section_id, 'section_id').required(values.level, 'level').required(values.subject_id, 'subject_id');
  if (v.ok && db.get().prepare('SELECT 1 FROM plans WHERE year_id = ? AND section_id = ? AND level = ? AND subject_id = ?').get(year.id, values.section_id, values.level, values.subject_id)) {
    v.errors.push({ field: 'level', key: 'plans.exists' });
  }
  if (!v.ok) {
    res.status(400);
    const rows = [];
    return res.render('plans/list', { title: req.t('plans.title'), rows, sectionId: null, ...lists(year.id), errors: v.errors, values });
  }
  const subj = db.get().prepare('SELECT * FROM subjects WHERE id = ?').get(values.subject_id);
  const info = db.get().prepare('INSERT INTO plans (year_id, section_id, level, subject_id, title, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(year.id, values.section_id, values.level, values.subject_id, values.title || `${subj.name_fr} / ${subj.name_en} — ${values.level}`, req.user.id);
  db.audit({ entity: 'plan', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: values });
  res.flash('ok', 'plans.created');
  res.redirect(`/plans/${info.lastInsertRowid}`);
});

function loadPlan(id) {
  return db.get().prepare(`SELECT p.*, se.name_en AS section_en, se.name_fr AS section_fr, s.name_en AS subject_en, s.name_fr AS subject_fr
    FROM plans p JOIN sections se ON se.id = p.section_id JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`).get(id);
}

function planContent(planId) {
  const chapters = db.get().prepare('SELECT ch.*, t.name AS term_name FROM plan_chapters ch LEFT JOIN terms t ON t.id = ch.term_id WHERE plan_id = ? ORDER BY ordinal').all(planId);
  const lessonStmt = db.get().prepare(`SELECT l.*, (SELECT COUNT(*) FROM progress_entries pe WHERE pe.lesson_id = l.id) AS used FROM plan_lessons l WHERE chapter_id = ? ORDER BY ordinal`);
  chapters.forEach((ch) => { ch.lessons = lessonStmt.all(ch.id); });
  return chapters;
}

r.get('/plans/:id', auth.requireRole('admin', 'teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const view = req.query.print === '1' ? 'plans/print' : 'plans/detail';
  res.render(view, { title: plan.title, plan, chapters: planContent(plan.id), terms: lists(plan.year_id).terms, importErrors: [], csv: '' });
});

r.post('/plans/:id/chapters', auth.requireRole('admin'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const title = str(req.body.title, 200);
  if (!title) { res.flash('error', 'validation.required'); return res.redirect(`/plans/${plan.id}`); }
  const max = db.get().prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_chapters WHERE plan_id = ?').get(plan.id).m;
  const termId = int(req.body.term_id);
  const info = db.get().prepare('INSERT INTO plan_chapters (plan_id, term_id, ordinal, title) VALUES (?, ?, ?, ?)').run(plan.id, termId, max + 1, title);
  db.audit({ entity: 'plan_chapter', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: { title, termId } });
  res.flash('ok', 'common.saved');
  res.redirect(`/plans/${plan.id}#ch-${info.lastInsertRowid}`);
});

r.post('/plans/chapters/:cid/lessons', auth.requireRole('admin'), (req, res) => {
  const ch = db.get().prepare('SELECT * FROM plan_chapters WHERE id = ?').get(int(req.params.cid));
  if (!ch) return auth.notFound(req, res);
  const title = str(req.body.title, 200);
  const plannedDate = str(req.body.planned_date, 10) || null;
  const hours = req.body.planned_hours ? Number(req.body.planned_hours) : null;
  if (!title || (plannedDate && !isDate(plannedDate)) || (hours !== null && !(hours >= 0 && hours < 500))) {
    res.flash('error', 'validation.checkFields');
    return res.redirect(`/plans/${ch.plan_id}#ch-${ch.id}`);
  }
  const max = db.get().prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_lessons WHERE chapter_id = ?').get(ch.id).m;
  const info = db.get().prepare('INSERT INTO plan_lessons (chapter_id, ordinal, title, planned_date, planned_hours) VALUES (?, ?, ?, ?, ?)').run(ch.id, max + 1, title, plannedDate, hours);
  db.audit({ entity: 'plan_lesson', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: { title, plannedDate, hours } });
  res.flash('ok', 'common.saved');
  res.redirect(`/plans/${ch.plan_id}#ch-${ch.id}`);
});

r.post('/plans/lessons/:lid', auth.requireRole('admin'), (req, res) => {
  const l = db.get().prepare('SELECT l.*, ch.plan_id FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE l.id = ?').get(int(req.params.lid));
  if (!l) return auth.notFound(req, res);
  const title = str(req.body.title, 200);
  const plannedDate = str(req.body.planned_date, 10) || null;
  const hours = req.body.planned_hours ? Number(req.body.planned_hours) : null;
  if (!title || (plannedDate && !isDate(plannedDate)) || (hours !== null && !(hours >= 0 && hours < 500))) {
    res.flash('error', 'validation.checkFields');
    return res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`);
  }
  db.get().prepare('UPDATE plan_lessons SET title = ?, planned_date = ?, planned_hours = ? WHERE id = ?').run(title, plannedDate, hours, l.id);
  db.audit({ entity: 'plan_lesson', entityId: l.id, action: 'update', userId: req.user.id, before: { title: l.title, planned_date: l.planned_date, planned_hours: l.planned_hours }, after: { title, planned_date: plannedDate, planned_hours: hours } });
  res.flash('ok', 'common.saved');
  res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`);
});

r.post('/plans/lessons/:lid/delete', auth.requireRole('admin'), (req, res) => {
  const l = db.get().prepare('SELECT l.*, ch.plan_id FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE l.id = ?').get(int(req.params.lid));
  if (!l) return auth.notFound(req, res);
  if (db.get().prepare('SELECT 1 FROM progress_entries WHERE lesson_id = ?').get(l.id)) {
    res.flash('error', 'plans.lessonInUse');
  } else {
    db.get().prepare('DELETE FROM plan_lessons WHERE id = ?').run(l.id);
    db.audit({ entity: 'plan_lesson', entityId: l.id, action: 'delete', userId: req.user.id, before: l });
    res.flash('ok', 'common.deleted');
  }
  res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`);
});

r.post('/plans/chapters/:cid/delete', auth.requireRole('admin'), (req, res) => {
  const ch = db.get().prepare('SELECT * FROM plan_chapters WHERE id = ?').get(int(req.params.cid));
  if (!ch) return auth.notFound(req, res);
  if (db.get().prepare('SELECT 1 FROM progress_entries pe JOIN plan_lessons l ON l.id = pe.lesson_id WHERE l.chapter_id = ?').get(ch.id)) {
    res.flash('error', 'plans.lessonInUse');
  } else {
    db.get().prepare('DELETE FROM plan_chapters WHERE id = ?').run(ch.id);
    db.audit({ entity: 'plan_chapter', entityId: ch.id, action: 'delete', userId: req.user.id, before: ch });
    res.flash('ok', 'common.deleted');
  }
  res.redirect(`/plans/${ch.plan_id}`);
});

// Accepts DD/MM/YYYY (common in Cameroon) or YYYY-MM-DD.
function normDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

// CSV import: chapter, lesson, planned date, planned hours, term name (optional). Lines are appended.
r.post('/plans/:id/import', auth.requireRole('admin'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const csv = String(req.body.csv || '').slice(0, 200000);
  const rows = parseCsv(csv);
  const terms = lists(plan.year_id).terms;
  const errors = [];
  if (rows.length && /chap/i.test(rows[0][0] || '')) rows.shift(); // header row
  const parsed = rows.map((r0, i) => {
    const [chapter, lesson, date, hours, termName] = r0;
    const planned = normDate(date);
    const term = termName ? terms.find((t) => t.name.toLowerCase() === termName.toLowerCase()) : null;
    if (!chapter || !lesson) errors.push(req.t('plans.importRowMissing', { row: i + 1 }));
    if (planned && !isDate(planned)) errors.push(req.t('plans.importRowDate', { row: i + 1 }));
    if (hours && !(Number(hours.replace(',', '.')) >= 0)) errors.push(req.t('plans.importRowHours', { row: i + 1 }));
    if (termName && !term) errors.push(req.t('plans.importRowTerm', { row: i + 1, term: termName }));
    return { chapter, lesson, planned, hours: hours ? Number(hours.replace(',', '.')) : null, termId: term ? term.id : null };
  });
  if (!rows.length) errors.push(req.t('plans.importEmpty'));
  if (errors.length) {
    return res.status(400).render('plans/detail', { title: plan.title, plan, chapters: planContent(plan.id), terms, importErrors: errors, csv });
  }
  const d = db.get();
  let lessons = 0;
  d.transaction(() => {
    const chapterIds = new Map(d.prepare('SELECT id, title FROM plan_chapters WHERE plan_id = ?').all(plan.id).map((c) => [c.title.toLowerCase(), c.id]));
    for (const row of parsed) {
      let cid = chapterIds.get(row.chapter.toLowerCase());
      if (!cid) {
        const max = d.prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_chapters WHERE plan_id = ?').get(plan.id).m;
        cid = Number(d.prepare('INSERT INTO plan_chapters (plan_id, term_id, ordinal, title) VALUES (?, ?, ?, ?)').run(plan.id, row.termId, max + 1, row.chapter.slice(0, 200)).lastInsertRowid);
        chapterIds.set(row.chapter.toLowerCase(), cid);
      }
      const max = d.prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_lessons WHERE chapter_id = ?').get(cid).m;
      d.prepare('INSERT INTO plan_lessons (chapter_id, ordinal, title, planned_date, planned_hours) VALUES (?, ?, ?, ?, ?)').run(cid, max + 1, row.lesson.slice(0, 200), row.planned, row.hours);
      lessons++;
    }
    db.audit({ entity: 'plan', entityId: plan.id, action: 'import', userId: req.user.id, after: { lessons } });
  })();
  res.flash('ok', 'plans.imported');
  res.redirect(`/plans/${plan.id}`);
});

module.exports = r;
