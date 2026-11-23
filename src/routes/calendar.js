'use strict';
// School calendar of activities: evaluations, deadlines, meetings, holidays. Read-only for
// everyone signed in; the content comes from the school-data import.
const express = require('express');
const db = require('../db');
const auth = require('../auth');

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

module.exports = r;
