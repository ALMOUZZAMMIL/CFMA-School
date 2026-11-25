'use strict';
// Lesson progress against the yearly plan.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const access = require('../access');
const auth = require('../auth');
const reports = require('../reports');
const scanner = require('../scanner');
const { Validator, int, str, isDate, isTime, weekday, addDays } = require('../util');

const r = express.Router();
// Router-level guard (defence in depth): every path below also checks its role itself.
r.use('/progress', auth.requireRole('admin', 'teacher'));

function allAssignments(yearId, { classId = null, teacherId = null } = {}) {
  return db.get().prepare(`SELECT ta.*, c.name AS class_name, c.level, c.section_id, c.year_id, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    WHERE c.year_id = @year AND (@cls IS NULL OR c.id = @cls) AND (@tid IS NULL OR ta.teacher_id = @tid)
    ORDER BY c.name, s.name_en`).all({ year: yearId, cls: classId, tid: teacherId });
}

const STATES = ['far_behind', 'behind', 'on_track', 'ahead', 'not_submitted', 'no_plan'];

// Curriculum tracker: for every class and subject, where it should be on the chosen date,
// where it actually is, and whether it is behind. Behind first.
r.get('/progress', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const asOf = isDate(req.query.date) ? req.query.date : res.locals.today;
  const settings = db.getSettings();
  const classId = int(req.query.class);
  const teacherId = int(req.query.teacher);
  const list = req.user.role === 'teacher'
    ? access.teacherAssignments(req.user.id, year.id).map((a) => ({ ...a, year_id: year.id }))
    : allAssignments(year.id, { classId, teacherId });
  const all = list.map((a) => {
    const p = reports.progressFor(a, asOf);
    return { a, p, status: reports.curriculumStatus(p, settings) };
  }).sort((x, y) => reports.STATUS_ORDER[x.status] - reports.STATUS_ORDER[y.status] || y.p.daysBehind - x.p.daysBehind || x.p.gap - y.p.gap);
  const counts = Object.fromEntries(STATES.map((k) => [k, all.filter((x) => x.status === k).length]));
  const state = STATES.includes(req.query.state) ? req.query.state : (req.query.state === 'late' ? 'late' : null);
  const rows = state === 'late' ? all.filter((x) => x.status === 'behind' || x.status === 'far_behind') : state ? all.filter((x) => x.status === state) : all;
  // Per teacher: how many of their classes are behind, and the worst delay.
  const byTeacher = [];
  if (req.user.role === 'admin') {
    const m = new Map();
    for (const x of all) {
      if (!m.has(x.a.teacher_id)) m.set(x.a.teacher_id, { id: x.a.teacher_id, name: x.a.teacher_name, total: 0, late: 0, far: 0, worst: 0, notSubmitted: 0 });
      const t = m.get(x.a.teacher_id);
      t.total++;
      if (x.status === 'behind' || x.status === 'far_behind') t.late++;
      if (x.status === 'far_behind') t.far++;
      if (x.status === 'not_submitted' || x.status === 'no_plan') t.notSubmitted++;
      t.worst = Math.max(t.worst, x.status === 'behind' || x.status === 'far_behind' ? x.p.daysBehind : 0);
    }
    byTeacher.push(...[...m.values()].filter((t) => t.late).sort((a, b) => b.far - a.far || b.late - a.late || b.worst - a.worst));
  }
  const classes = db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  const teachers = db.get().prepare("SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name").all();
  res.render('progress/list', {
    title: req.t('progress.title'), rows, counts, state, byTeacher, asOf, classes, teachers, q: req.query, total: all.length,
    grace: Number(settings.progress_grace_days) || 5, alertDays: Number(settings.progress_alert_days) || 15,
  });
});

// Current time (HH:MM) in the school's time zone.
// (scanner.nowIn also follows the frozen demo clock, so both halves of the page agree.)
function nowTime(timezone) {
  return scanner.nowIn(timezone).time.slice(0, 5);
}

// "Who should be teaching what, right now?" Every timetable slot of one day with the lesson
// the progression sheet says should be taught, the lesson actually reached, and whether the
// class was recorded as held.
r.get('/progress/now', auth.requireRole('admin'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const today = res.locals.today;
  const date = isDate(req.query.date) ? req.query.date : today;
  const time = isTime(req.query.time) ? req.query.time : (date === today ? nowTime(db.getSettings().timezone) : null);
  const settings = db.getSettings();
  const closed = reports.closedDates(year.id).has(date);
  const exams = db.get().prepare(`SELECT * FROM school_events WHERE year_id = ? AND category = 'evaluation'
    AND start_date <= ? AND COALESCE(end_date, start_date) >= ?`).all(year.id, date, date);
  const slots = closed ? [] : db.get().prepare(`SELECT ts.*, ta.teacher_id, ta.class_id, ta.subject_id, c.name AS class_name, c.level, c.section_id, c.year_id,
      s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name,
      cs.status AS session_status
    FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id JOIN teaching_assignments ta ON ta.id = ts.assignment_id
    JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    LEFT JOIN class_sessions cs ON cs.slot_id = ts.id AND cs.date = @date
    WHERE c.year_id = @year AND t.start_date <= @date AND t.end_date >= @date AND ts.day_of_week = @dow
    ORDER BY ts.start_time, c.name`).all({ year: year.id, date, dow: weekday(date) });
  // Did the teacher scan in for this lesson? (fingerprint scanner; nothing shown before it is in use)
  if (!closed && date <= today) scanner.recomputeDate(date);
  const scans = new Map(closed ? [] : scanner.board(date).map((b) => [b.id, b]));
  const scannerOn = !!settings.scanner_start_date && settings.scanner_start_date <= date;
  const cache = new Map();
  const rows = slots.map((sl) => {
    if (!cache.has(sl.assignment_id)) {
      const p = reports.progressFor({ id: sl.assignment_id, year_id: sl.year_id, section_id: sl.section_id, level: sl.level, subject_id: sl.subject_id }, date);
      cache.set(sl.assignment_id, { p, status: reports.curriculumStatus(p, settings) });
    }
    const x = cache.get(sl.assignment_id);
    const sc = scans.get(sl.id);
    return { sl, p: x.p, status: x.status, scan: scannerOn && sc ? { state: sc.state, late: sc.late, early: sc.early, lateMin: sc.lesson ? sc.lesson.late_min : 0, earlyMin: sc.lesson ? sc.lesson.early_min : 0 } : null, now: !!time && sl.start_time <= time && time < sl.end_time, past: !!time && sl.end_time <= time };
  });
  const days = [];
  const monday = addDays(date, 1 - weekday(date));
  for (let i = 0; i < 6; i++) days.push(addDays(monday, i));
  res.render('progress/now', {
    title: req.t('progress.nowTitle'), rows, date, time, today, closed, days, exams,
    prev: addDays(date, -1), next: addDays(date, 1), current: rows.filter((x) => x.now), scannerOn,
  });
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
