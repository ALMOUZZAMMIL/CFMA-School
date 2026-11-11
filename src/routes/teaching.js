'use strict';
// Timetable, class sessions (held / missed / cancelled / make-up) and teaching hours.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const access = require('../access');
const auth = require('../auth');
const { Validator, int, str, isDate, weekday, minutesBetween } = require('../util');

const r = express.Router();
// Router-level guard (defence in depth): every path below also checks its role itself.
r.use(['/teaching', '/sessions'], auth.requireRole('admin', 'teacher'));
const STATUSES = ['held', 'missed', 'cancelled', 'makeup'];
const MAKEUP = ['none', 'planned', 'completed', 'not_needed'];

function slotsForDay(teacherId, date) {
  return db.get().prepare(`SELECT ts.*, ta.class_id, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr,
      u.full_name AS teacher_name, cs.id AS session_id, cs.status AS session_status, cs.makeup_status
    FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id JOIN teaching_assignments ta ON ta.id = ts.assignment_id
    JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    LEFT JOIN class_sessions cs ON cs.slot_id = ts.id AND cs.date = @date
    WHERE (@tid IS NULL OR ta.teacher_id = @tid) AND ts.day_of_week = @dow AND @date BETWEEN t.start_date AND t.end_date
    ORDER BY ts.start_time, u.full_name`).all({ tid: teacherId, date, dow: weekday(date) });
}

function closureOn(date) {
  return db.get().prepare('SELECT * FROM closures WHERE ? BETWEEN start_date AND end_date LIMIT 1').get(date);
}

// Day view of scheduled classes, with their recorded status.
r.get('/teaching', auth.requireRole('admin', 'teacher'), (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : res.locals.today;
  const teacherId = req.user.role === 'teacher' ? req.user.id : (int(req.query.teacher) || null);
  const teachers = req.user.role === 'admin' ? db.get().prepare("SELECT id, full_name FROM users WHERE role = 'teacher' AND active = 1 ORDER BY full_name").all() : [];
  res.render('teaching/day', {
    title: req.t('teaching.dayTitle'), date, teacherId, teachers, slots: slotsForDay(teacherId, date), closure: closureOn(date),
  });
});

// Weekly timetable for the logged-in teacher.
r.get('/timetable', (req, res) => {
  const year = res.locals.year;
  if (!year) return res.render('timetable', { title: req.t('nav.timetable'), slots: [], terms: [], termId: null, heading: '' });
  const terms = db.get().prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(year.id);
  const today = res.locals.today;
  const current = terms.find((t) => today >= t.start_date && today <= t.end_date) || terms[0];
  const termId = int(req.query.term) || (current && current.id);
  let where;
  let params;
  if (req.user.role === 'teacher') { where = 'ta.teacher_id = ?'; params = [req.user.id]; }
  else if (req.user.role === 'student' || req.user.role === 'parent') {
    // Parents pick a child; students see their own class.
    const ids = access.visibleStudentIds(req.user);
    const sid = int(req.query.student) || ids[0];
    if (!ids.includes(sid)) return auth.notFound(req, res);
    const cls = access.studentClass(sid, year.id);
    where = 'ta.class_id = ?'; params = [cls ? cls.id : -1];
  } else if (req.user.role === 'admin') {
    const cid = int(req.query.class);
    const tid = int(req.query.teacher);
    if (cid) { where = 'ta.class_id = ?'; params = [cid]; } else if (tid) { where = 'ta.teacher_id = ?'; params = [tid]; } else { where = '1=0'; params = []; }
  } else return auth.forbidden(req, res);
  const slots = db.get().prepare(`SELECT ts.*, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
    FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id JOIN classes c ON c.id = ta.class_id
    JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    WHERE ts.term_id = ? AND ${where} ORDER BY ts.day_of_week, ts.start_time`).all(termId, ...params);
  const extra = {};
  if (req.user.role === 'admin') {
    extra.classes = db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
    extra.teachers = db.get().prepare("SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name").all();
  }
  if (req.user.role === 'parent') {
    extra.children = access.visibleStudentIds(req.user).map((id) => db.get().prepare('SELECT id, full_name FROM students WHERE id = ?').get(id));
  }
  res.render('timetable', { title: req.t('nav.timetable'), slots, terms, termId, query: req.query, ...extra });
});

function sessionForm(req, res, { session, errors = [], status = 200 }) {
  const a = access.assignment(session.assignment_id);
  const missedSessions = db.get().prepare(`SELECT * FROM class_sessions WHERE assignment_id = ? AND status IN ('missed','cancelled')
    AND makeup_status IN ('planned','none') ORDER BY date DESC LIMIT 30`).all(session.assignment_id);
  res.status(status).render('teaching/session-form', { title: req.t('teaching.recordTitle'), session, a, errors, missedSessions });
}

r.get('/sessions/new', auth.requireRole('admin', 'teacher'), (req, res) => {
  const slotId = int(req.query.slot);
  const date = isDate(req.query.date) ? req.query.date : res.locals.today;
  let session;
  if (slotId) {
    const slot = db.get().prepare('SELECT * FROM timetable_slots WHERE id = ?').get(slotId);
    if (!slot) return auth.notFound(req, res);
    const existing = db.get().prepare('SELECT id FROM class_sessions WHERE slot_id = ? AND date = ?').get(slotId, date);
    if (existing) return res.redirect(`/sessions/${existing.id}`);
    session = { assignment_id: slot.assignment_id, slot_id: slot.id, date, start_time: slot.start_time, end_time: slot.end_time, status: 'held', makeup_status: 'none' };
  } else {
    const aid = int(req.query.assignment);
    session = { assignment_id: aid, slot_id: null, date, start_time: '', end_time: '', status: 'makeup', makeup_status: 'none', makeup_for_session_id: int(req.query.makeup_for) };
  }
  const a = access.assignment(session.assignment_id);
  if (!access.canManageAssignment(req.user, a)) return auth.notFound(req, res);
  session.client_uuid = crypto.randomUUID();
  sessionForm(req, res, { session });
});

// Reads and validates a session form. Returns { values, v }.
function readSessionForm(body, a) {
  const values = {
    client_uuid: str(body.client_uuid, 64) || null,
    assignment_id: a.id,
    slot_id: int(body.slot_id),
    date: str(body.date, 10),
    start_time: str(body.start_time, 5),
    end_time: str(body.end_time, 5),
    status: str(body.status, 20),
    reason: str(body.reason, 500) || null,
    makeup_status: str(body.makeup_status, 20) || 'none',
    makeup_planned_date: str(body.makeup_planned_date, 10) || null,
    makeup_for_session_id: int(body.makeup_for_session_id),
    notes: str(body.notes, 2000) || null,
  };
  const v = new Validator()
    .required(values.date, 'date').date(values.date, 'date')
    .required(values.start_time, 'start_time').time(values.start_time, 'start_time')
    .required(values.end_time, 'end_time').time(values.end_time, 'end_time')
    .required(values.status, 'status').oneOf(values.status, STATUSES, 'status')
    .oneOf(values.makeup_status, MAKEUP, 'makeup_status')
    .date(values.makeup_planned_date, 'makeup_planned_date');
  if (values.start_time && values.end_time && v.ok) v.check(minutesBetween(values.start_time, values.end_time) > 0, 'end_time', 'validation.endAfterStart');
  if (values.status === 'missed' || values.status === 'cancelled') {
    v.required(values.reason, 'reason');
    if (values.makeup_status === 'planned') v.required(values.makeup_planned_date, 'makeup_planned_date');
  } else {
    values.makeup_status = 'none';
    values.makeup_planned_date = null;
  }
  if (values.status === 'makeup') values.slot_id = null;
  else values.makeup_for_session_id = null;
  if (values.slot_id) {
    const slot = db.get().prepare('SELECT ts.*, t.start_date, t.end_date FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id WHERE ts.id = ?').get(values.slot_id);
    v.check(slot && slot.assignment_id === a.id, 'slot_id', 'validation.choice');
    if (slot && isDate(values.date)) v.check(weekday(values.date) === slot.day_of_week && values.date >= slot.start_date && values.date <= slot.end_date, 'date', 'teaching.dateNotOnTimetable');
  } else if (values.status !== 'makeup') {
    values.slot_id = null; // an extra, unscheduled lesson
  }
  if (values.makeup_for_session_id) {
    const orig = db.get().prepare('SELECT * FROM class_sessions WHERE id = ?').get(values.makeup_for_session_id);
    v.check(orig && orig.assignment_id === a.id && ['missed', 'cancelled'].includes(orig.status), 'makeup_for_session_id', 'validation.choice');
  }
  return { values, v };
}

r.post('/sessions', auth.requireRole('admin', 'teacher'), (req, res) => {
  const a = access.assignment(int(req.body.assignment_id));
  if (!access.canManageAssignment(req.user, a)) return auth.notFound(req, res);
  const { values, v } = readSessionForm(req.body, a);
  // Same form submitted twice (double tap, retry on a slow connection): show the saved record.
  if (values.client_uuid) {
    const dup = db.get().prepare('SELECT id FROM class_sessions WHERE client_uuid = ?').get(values.client_uuid);
    if (dup) return res.redirect(`/sessions/${dup.id}`);
  }
  if (values.slot_id && db.get().prepare('SELECT 1 FROM class_sessions WHERE slot_id = ? AND date = ?').get(values.slot_id, values.date)) {
    v.errors.push({ field: 'date', key: 'teaching.alreadyRecorded' });
  }
  if (!v.ok) return sessionForm(req, res, { session: values, errors: v.errors, status: 400 });
  const id = db.get().transaction(() => {
    const info = db.get().prepare(`INSERT INTO class_sessions (client_uuid, assignment_id, slot_id, date, start_time, end_time, status, reason,
      makeup_status, makeup_planned_date, makeup_for_session_id, notes, recorded_by)
      VALUES (@client_uuid, @assignment_id, @slot_id, @date, @start_time, @end_time, @status, @reason, @makeup_status, @makeup_planned_date,
      @makeup_for_session_id, @notes, @uid)`).run({ ...values, uid: req.user.id });
    const newId = Number(info.lastInsertRowid);
    db.audit({ entity: 'class_session', entityId: newId, action: 'create', userId: req.user.id, after: values });
    if (values.makeup_for_session_id) {
      const before = db.get().prepare('SELECT * FROM class_sessions WHERE id = ?').get(values.makeup_for_session_id);
      db.get().prepare("UPDATE class_sessions SET makeup_status = 'completed', updated_at = datetime('now') WHERE id = ?").run(before.id);
      db.audit({ entity: 'class_session', entityId: before.id, action: 'makeup_completed', userId: req.user.id, reason: `#${newId}`, before: { makeup_status: before.makeup_status }, after: { makeup_status: 'completed' } });
    }
    return newId;
  })();
  res.flash('ok', 'teaching.saved');
  res.redirect(values.slot_id ? `/teaching?date=${values.date}` : `/sessions/${id}`);
});

function loadSession(req) {
  const s = db.get().prepare(`SELECT cs.*, u.full_name AS recorded_by_name FROM class_sessions cs JOIN users u ON u.id = cs.recorded_by WHERE cs.id = ?`).get(int(req.params.id));
  if (!s) return null;
  const a = access.assignment(s.assignment_id);
  if (!access.canManageAssignment(req.user, a)) return null;
  return { s, a };
}

r.get('/sessions/:id', auth.requireRole('admin', 'teacher'), (req, res) => {
  const found = loadSession(req);
  if (!found) return auth.notFound(req, res);
  const history = db.get().prepare(`SELECT al.*, u.full_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.entity = 'class_session' AND al.entity_id = ? ORDER BY al.id DESC`).all(found.s.id);
  history.forEach((h) => { h.before = h.before_json ? JSON.parse(h.before_json) : null; h.after = h.after_json ? JSON.parse(h.after_json) : null; });
  const makeups = db.get().prepare('SELECT * FROM class_sessions WHERE makeup_for_session_id = ? ORDER BY date').all(found.s.id);
  const original = found.s.makeup_for_session_id ? db.get().prepare('SELECT * FROM class_sessions WHERE id = ?').get(found.s.makeup_for_session_id) : null;
  res.render('teaching/session-view', { title: req.t('teaching.sessionTitle'), s: found.s, a: found.a, history, makeups, original });
});

r.get('/sessions/:id/edit', auth.requireRole('admin', 'teacher'), (req, res) => {
  const found = loadSession(req);
  if (!found) return auth.notFound(req, res);
  sessionForm(req, res, { session: found.s });
});

// Corrections keep the old values in the history and need a reason.
r.post('/sessions/:id', auth.requireRole('admin', 'teacher'), (req, res) => {
  const found = loadSession(req);
  if (!found) return auth.notFound(req, res);
  const { values, v } = readSessionForm({ ...req.body, slot_id: found.s.slot_id, makeup_for_session_id: found.s.makeup_for_session_id, client_uuid: found.s.client_uuid }, found.a);
  if (found.s.slot_id) values.date = found.s.date; // a scheduled session stays on its date
  const changeReason = str(req.body.change_reason, 500);
  v.required(changeReason, 'change_reason');
  if (found.s.slot_id && values.status === 'makeup') v.errors.push({ field: 'status', key: 'validation.choice' });
  if (!v.ok) return sessionForm(req, res, { session: { ...found.s, ...values, id: found.s.id, change_reason: changeReason }, errors: v.errors, status: 400 });
  const fields = ['date', 'start_time', 'end_time', 'status', 'reason', 'makeup_status', 'makeup_planned_date', 'notes'];
  const before = {};
  const after = {};
  for (const f of fields) if ((found.s[f] ?? null) !== (values[f] ?? null)) { before[f] = found.s[f]; after[f] = values[f]; }
  if (Object.keys(after).length) {
    db.get().transaction(() => {
      db.get().prepare(`UPDATE class_sessions SET date=@date, start_time=@start_time, end_time=@end_time, status=@status, reason=@reason,
        makeup_status=@makeup_status, makeup_planned_date=@makeup_planned_date, notes=@notes, updated_at=datetime('now') WHERE id=@id`).run({ ...values, id: found.s.id });
      db.audit({ entity: 'class_session', entityId: found.s.id, action: 'update', userId: req.user.id, reason: changeReason, before, after });
    })();
    res.flash('ok', 'teaching.corrected');
  } else res.flash('info', 'common.noChanges');
  res.redirect(`/sessions/${found.s.id}`);
});

// List of recorded sessions, with filters.
r.get('/sessions', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const teacherId = req.user.role === 'teacher' ? req.user.id : int(req.query.teacher);
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const pendingOnly = req.query.pending === '1';
  const from = isDate(req.query.from) ? req.query.from : year.start_date;
  const to = isDate(req.query.to) ? req.query.to : year.end_date;
  const rows = db.get().prepare(`SELECT cs.*, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
    FROM class_sessions cs JOIN teaching_assignments ta ON ta.id = cs.assignment_id JOIN classes c ON c.id = ta.class_id
    JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    WHERE c.year_id = @year AND cs.date BETWEEN @from AND @to AND (@tid IS NULL OR ta.teacher_id = @tid) AND (@status IS NULL OR cs.status = @status)
    ${pendingOnly ? "AND cs.status IN ('missed','cancelled') AND cs.makeup_status = 'planned'" : ''}
    ORDER BY cs.date DESC, cs.start_time DESC LIMIT 500`).all({ year: year.id, from, to, tid: teacherId || null, status });
  const teachers = req.user.role === 'admin' ? db.get().prepare("SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name").all() : [];
  const assignments = req.user.role === 'teacher' ? access.teacherAssignments(req.user.id, year.id) : [];
  res.render('teaching/sessions', { title: req.t('teaching.sessionsTitle'), rows, teachers, assignments, q: { teacherId, status, from, to, pendingOnly } });
});

module.exports = r;
