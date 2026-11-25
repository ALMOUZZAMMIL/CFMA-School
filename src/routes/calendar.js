'use strict';
// School calendar of activities: evaluations, deadlines, meetings, holidays. Read-only for
// everyone signed in; the content comes from the school-data import.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { int, str, isDate } = require('../util');

const r = express.Router();
const CATEGORIES = ['term', 'evaluation', 'deadline', 'meeting', 'week', 'celebration', 'tutorial', 'admin', 'holiday', 'other'];
// Deadlines and staff-only steps are not useful to parents and students.
const STAFF_ONLY = ['deadline', 'admin'];

r.get('/calendar', auth.requireLogin, (req, res) => {
  const year = res.locals.year;
  const today = res.locals.today;
  const staff = ['admin', 'teacher', 'bursar'].includes(req.user.role);
  if (!year) return res.render('calendar', { title: req.t('calendar.title'), months: [], next: null, staff, filter: '' });
  const filter = CATEGORIES.includes(req.query.show) ? req.query.show : '';
  const d = db.get();
  let events = d.prepare('SELECT * FROM school_events WHERE year_id = ? ORDER BY start_date, end_date, id').all(year.id);
  const closures = d.prepare('SELECT * FROM closures WHERE year_id = ? ORDER BY start_date').all(year.id).map((c) => {
    const [fr, en] = String(c.reason).split(' / ');
    return { id: `c${c.id}`, start_date: c.start_date, end_date: c.end_date, category: 'holiday', title_fr: fr, title_en: en || fr };
  });
  events = events.concat(closures).sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
  if (!staff) events = events.filter((e) => !STAFF_ONLY.includes(e.category));
  if (filter) events = events.filter((e) => e.category === filter);
  events.forEach((e) => { e.state = e.end_date < today ? 'past' : e.start_date <= today ? 'now' : 'soon'; });
  const months = [];
  for (const e of events) {
    const key = e.start_date.slice(0, 7);
    let m = months[months.length - 1];
    if (!m || m.key !== key) { m = { key, events: [] }; months.push(m); }
    m.events.push(e);
  }
  const next = events.find((e) => e.state !== 'past') || null;
  const cats = CATEGORIES.filter((c) => staff || !STAFF_ONLY.includes(c));
  res.render('calendar', { title: req.t('calendar.title'), months, next, staff, filter, cats });
});

/* ---------- Exam timetable (administration) ----------
   Exam periods are calendar events of category 'evaluation'. For each one the administration
   says whether lessons stop during it: if they do, those days are skipped when lesson dates are
   worked out and are not counted when measuring how far behind a class is. */
r.get('/calendar/exams', auth.requireRole('admin'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/calendar');
  const exams = db.get().prepare("SELECT * FROM school_events WHERE year_id = ? AND category = 'evaluation' ORDER BY start_date, end_date").all(year.id);
  res.render('exams', { title: req.t('exams.title'), exams, today: res.locals.today });
});

r.post('/calendar/exams', auth.requireRole('admin'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/calendar');
  const v = {
    start_date: str(req.body.start_date, 10), end_date: str(req.body.end_date, 10) || str(req.body.start_date, 10),
    title_fr: str(req.body.title_fr, 200), title_en: str(req.body.title_en, 200), pauses: req.body.pauses_lessons === '1' ? 1 : 0,
  };
  if (!isDate(v.start_date) || !isDate(v.end_date) || v.end_date < v.start_date || !(v.title_fr || v.title_en)) {
    res.flash('error', 'validation.checkFields');
    return res.redirect('/calendar/exams');
  }
  const info = db.get().prepare(`INSERT INTO school_events (year_id, start_date, end_date, category, title_fr, title_en, pauses_lessons, source)
    VALUES (?, ?, ?, 'evaluation', ?, ?, ?, 'admin')`).run(year.id, v.start_date, v.end_date, v.title_fr || v.title_en, v.title_en || v.title_fr, v.pauses);
  db.audit({ entity: 'school_event', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  res.flash('ok', 'common.saved');
  res.redirect('/calendar/exams');
});

function loadExam(id) {
  return db.get().prepare("SELECT * FROM school_events WHERE id = ? AND category = 'evaluation'").get(id);
}

r.post('/calendar/exams/:id/pause', auth.requireRole('admin'), (req, res) => {
  const e = loadExam(int(req.params.id));
  if (!e) return auth.notFound(req, res);
  const pauses = req.body.pauses_lessons === '1' ? 1 : 0;
  db.get().prepare('UPDATE school_events SET pauses_lessons = ? WHERE id = ?').run(pauses, e.id);
  db.audit({ entity: 'school_event', entityId: e.id, action: 'pauses_lessons', userId: req.user.id, before: { pauses: e.pauses_lessons }, after: { pauses } });
  res.flash('ok', 'common.saved');
  res.redirect('/calendar/exams');
});

r.post('/calendar/exams/:id/delete', auth.requireRole('admin'), (req, res) => {
  const e = loadExam(int(req.params.id));
  if (!e) return auth.notFound(req, res);
  if (e.source !== 'admin') { res.flash('error', 'exams.importedNoDelete'); return res.redirect('/calendar/exams'); }
  db.get().prepare('DELETE FROM school_events WHERE id = ?').run(e.id);
  db.audit({ entity: 'school_event', entityId: e.id, action: 'delete', userId: req.user.id, before: e });
  res.flash('ok', 'common.deleted');
  res.redirect('/calendar/exams');
});

module.exports = r;
