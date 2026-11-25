'use strict';
// School-wide reports: teaching hours, lesson progress and repeated absences, with print and CSV export.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const reports = require('../reports');
const { int, isDate, toCsv } = require('../util');

const r = express.Router();

function filters(req, res) {
  const year = res.locals.year;
  const teacherId = req.user.role === 'teacher' ? req.user.id : int(req.query.teacher);
  return {
    yearId: year.id,
    termId: int(req.query.term),
    teacherId,
    classId: int(req.query.class),
    subjectId: int(req.query.subject),
    asOf: isDate(req.query.date) ? req.query.date : res.locals.today,
  };
}

function groupRows(rows, by) {
  if (by === 'assignment') return rows;
  const keyOf = { teacher: (x) => x.teacher_id, class: (x) => x.class_id, subject: (x) => x.subject_id }[by];
  const map = new Map();
  for (const x of rows) {
    const k = keyOf(x);
    const g = map.get(k) || { ...x, scheduled: 0, held: 0, missed: 0, cancelled: 0, makeup: 0, delivered: 0, notRecorded: 0, makeupPending: 0 };
    for (const f of ['scheduled', 'held', 'missed', 'cancelled', 'makeup', 'delivered', 'notRecorded', 'makeupPending']) g[f] = Math.round((g[f] + x[f]) * 10) / 10;
    map.set(k, g);
  }
  return [...map.values()].map((g) => ({ ...g, rate: g.scheduled ? Math.round((g.delivered / g.scheduled) * 100) : null }));
}

r.get('/reports/hours', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const f = filters(req, res);
  const by = ['assignment', 'teacher', 'class', 'subject'].includes(req.query.by) ? req.query.by : 'assignment';
  const { rows, from, to } = reports.hoursSummary(f);
  const grouped = groupRows(rows, by);
  const t = req.t;
  const ln = res.locals.ln;
  if (req.query.format === 'csv') {
    res.type('text/csv; charset=utf-8').attachment(`teaching-hours-${from}-${to}.csv`);
    return res.send(toCsv(
      [t('common.teacher'), t('common.class'), t('common.subject'), t('hours.scheduled'), t('hours.held'), t('hours.makeup'), t('hours.missed'), t('hours.cancelled'), t('hours.delivered'), t('hours.rate'), t('hours.notRecorded'), t('hours.makeupPending')],
      grouped.map((x) => [by === 'class' || by === 'subject' ? '' : x.teacher_name, by === 'teacher' || by === 'subject' ? '' : x.class_name, by === 'teacher' || by === 'class' ? '' : ln(x, 'subject'), x.scheduled, x.held, x.makeup, x.missed, x.cancelled, x.delivered, x.rate === null ? '' : `${x.rate}%`, x.notRecorded, x.makeupPending]),
    ));
  }
  const d = db.get();
  res.render('reports/hours', {
    title: t('hours.title'), rows: grouped, by, from, to, f, print: req.query.print === '1',
    terms: d.prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(year.id),
    teachers: req.user.role === 'admin' ? d.prepare("SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name").all() : [],
    classes: d.prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id),
    subjects: d.prepare('SELECT * FROM subjects ORDER BY name_en').all(),
  });
});

r.get('/reports/absences', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const s = res.locals.settings;
  const threshold = int(req.query.threshold) || Number(s.repeat_absence_threshold);
  const days = int(req.query.days) || Number(s.repeat_absence_window_days);
  const asOf = isDate(req.query.date) ? req.query.date : res.locals.today;
  let classId = int(req.query.class);
  // Teachers only see the classes they teach.
  const classes = req.user.role === 'admin'
    ? db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id)
    : db.get().prepare('SELECT DISTINCT c.id, c.name FROM classes c JOIN teaching_assignments ta ON ta.class_id = c.id WHERE ta.teacher_id = ? AND c.year_id = ? ORDER BY c.name').all(req.user.id, year.id);
  if (req.user.role === 'teacher' && classId && !classes.some((c) => c.id === classId)) return auth.notFound(req, res);
  let rows = reports.repeatedAbsences({ yearId: year.id, threshold, days, asOf, classId });
  if (req.user.role === 'teacher') {
    const allowed = new Set(classes.map((c) => c.id));
    rows = rows.filter((x) => allowed.has(x.class_id));
  }
  res.render('reports/absences', { title: req.t('absences.title'), rows, threshold, days, asOf, classes, classId });
});

r.get('/admin/outbox', auth.requireRole('admin'), (req, res) => {
  const rows = db.get().prepare(`SELECT m.*, u.full_name, u.phone FROM message_outbox m JOIN users u ON u.id = m.recipient_user_id ORDER BY m.id DESC LIMIT 300`).all();
  res.render('admin/outbox', { title: req.t('outbox.title'), rows });
});

r.get('/admin/audit', auth.requireRole('admin'), (req, res) => {
  const entity = typeof req.query.entity === 'string' && /^[a-z_]+$/.test(req.query.entity) ? req.query.entity : null;
  const rows = db.get().prepare(`SELECT al.*, u.full_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    WHERE (? IS NULL OR al.entity = ?) ORDER BY al.id DESC LIMIT 300`).all(entity, entity);
  const entities = db.get().prepare('SELECT DISTINCT entity FROM audit_log ORDER BY entity').all().map((x) => x.entity);
  res.render('admin/audit', { title: req.t('audit.title'), rows, entities, entity });
});

module.exports = r;
