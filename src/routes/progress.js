'use strict';
// Lesson progress against the yearly plan.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const access = require('../access');
const auth = require('../auth');
const reports = require('../reports');
const { Validator, int, str, isDate } = require('../util');

const r = express.Router();
// Router-level guard (defence in depth): every path below also checks its role itself.
r.use('/progress', auth.requireRole('admin', 'teacher'));

r.get('/progress', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const asOf = isDate(req.query.date) ? req.query.date : res.locals.today;
  let list;
  if (req.user.role === 'teacher') list = access.teacherAssignments(req.user.id, year.id);
  else {
    list = db.get().prepare(`SELECT ta.*, c.name AS class_name, c.level, c.section_id, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
      FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
      WHERE c.year_id = @year AND (@cls IS NULL OR c.id = @cls) AND (@tid IS NULL OR ta.teacher_id = @tid)
      ORDER BY c.name, s.name_en`).all({ year: year.id, cls: int(req.query.class), tid: int(req.query.teacher) });
  }
  const rows = list.map((a) => ({ a, p: reports.progressFor({ ...a, year_id: year.id }, asOf) }));
  const classes = db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  const teachers = db.get().prepare("SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name").all();
  res.render('progress/list', { title: req.t('progress.title'), rows, asOf, classes, teachers, q: req.query });
});

function render(req, res, a, { errors = [], values = {}, status = 200 } = {}) {
  const asOf = isDate(req.query.date) ? req.query.date : res.locals.today;
  const p = reports.progressFor(a, asOf);
  const history = db.get().prepare(`SELECT pe.*, l.title AS lesson_title, u.full_name FROM progress_entries pe JOIN plan_lessons l ON l.id = pe.lesson_id
    JOIN users u ON u.id = pe.recorded_by WHERE pe.assignment_id = ? ORDER BY pe.date DESC, pe.id DESC LIMIT 100`).all(a.id);
  // Suggest the next lesson that is not yet completed.
  const next = p.lessons.find((l) => !l.progress || l.progress.status !== 'completed');
  res.status(status).render('progress/detail', {
    title: req.t('progress.title'), a, p, asOf, history, errors,
    values: { lesson_id: next && next.id, date: res.locals.today, status: 'completed', client_uuid: crypto.randomUUID(), ...values },
  });
}

r.get('/progress/:aid', auth.requireRole('admin', 'teacher'), (req, res) => {
  const a = access.assignment(int(req.params.aid));
  if (!access.canManageAssignment(req.user, a)) return auth.notFound(req, res);
  render(req, res, a);
});

r.post('/progress/:aid', auth.requireRole('admin', 'teacher'), (req, res) => {
  const a = access.assignment(int(req.params.aid));
  if (!access.canManageAssignment(req.user, a)) return auth.notFound(req, res);
  const values = {
    client_uuid: str(req.body.client_uuid, 64) || null,
    lesson_id: int(req.body.lesson_id),
    date: str(req.body.date, 10),
    status: str(req.body.status, 20),
    notes: str(req.body.notes, 2000) || null,
  };
  const v = new Validator().required(values.lesson_id, 'lesson_id').required(values.date, 'date').date(values.date, 'date')
    .required(values.status, 'status').oneOf(values.status, ['in_progress', 'completed', 'delayed'], 'status');
  if (values.date && isDate(values.date)) v.check(values.date <= res.locals.today, 'date', 'validation.notFuture');
  if (values.status === 'delayed') v.required(values.notes, 'notes');
  // The lesson must belong to this class's plan.
  const lesson = values.lesson_id && db.get().prepare(`SELECT l.id FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id JOIN plans p ON p.id = ch.plan_id
    WHERE l.id = ? AND p.year_id = ? AND p.section_id = ? AND p.level = ? AND p.subject_id = ?`).get(values.lesson_id, a.year_id, a.section_id, a.level, a.subject_id);
  if (values.lesson_id) v.check(!!lesson, 'lesson_id', 'validation.choice');
  if (values.client_uuid && db.get().prepare('SELECT 1 FROM progress_entries WHERE client_uuid = ?').get(values.client_uuid)) {
    res.flash('info', 'common.alreadySaved');
    return res.redirect(`/progress/${a.id}`);
  }
  if (!v.ok) return render(req, res, a, { errors: v.errors, values, status: 400 });
  const info = db.get().prepare(`INSERT INTO progress_entries (client_uuid, assignment_id, lesson_id, date, status, notes, recorded_by)
    VALUES (@client_uuid, @aid, @lesson_id, @date, @status, @notes, @uid)`).run({ ...values, aid: a.id, uid: req.user.id });
  db.audit({ entity: 'progress_entry', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: values });
  res.flash('ok', 'progress.saved');
  res.redirect(`/progress/${a.id}`);
});

module.exports = r;
