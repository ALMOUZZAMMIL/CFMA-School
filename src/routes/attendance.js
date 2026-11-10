'use strict';
// Daily student attendance by class, with correction history and optional parent alerts.
const express = require('express');
const db = require('../db');
const access = require('../access');
const auth = require('../auth');
const { int, str, isDate, addDays, toCsv } = require('../util');

const r = express.Router();
// Router-level guard (defence in depth): every path below also checks its role itself.
r.use('/attendance', auth.requireRole('admin', 'teacher'));
const STATUSES = ['present', 'absent', 'late', 'excused'];

function classRow(id, yearId) {
  return db.get().prepare('SELECT c.*, se.name_en AS section_en, se.name_fr AS section_fr FROM classes c JOIN sections se ON se.id = c.section_id WHERE c.id = ? AND c.year_id = ?').get(id, yearId);
}

function roster(classId) {
  return db.get().prepare(`SELECT st.* FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.class_id = ? ORDER BY st.full_name`).all(classId);
}

r.get('/attendance', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const date = isDate(req.query.date) ? req.query.date : res.locals.today;
  const classes = req.user.role === 'admin'
    ? db.get().prepare('SELECT * FROM classes WHERE year_id = ? ORDER BY name').all(year.id)
    : db.get().prepare('SELECT DISTINCT c.* FROM classes c JOIN teaching_assignments ta ON ta.class_id = c.id WHERE ta.teacher_id = ? AND c.year_id = ? ORDER BY c.name').all(req.user.id, year.id);
  const countStmt = db.get().prepare(`SELECT COUNT(*) total, SUM(status='absent') absent, SUM(status='late') late,
    (SELECT COUNT(*) FROM enrollments WHERE class_id = @c) enrolled FROM attendance_records WHERE class_id = @c AND date = @d`);
  const rows = classes.map((c) => ({ ...c, ...countStmt.get({ c: c.id, d: date }) }));
  res.render('attendance/index', { title: req.t('attendance.title'), rows, date });
});

r.get('/attendance/:classId', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  const cls = year && classRow(int(req.params.classId), year.id);
  if (!cls || !access.canTakeAttendance(req.user, cls.id)) return auth.notFound(req, res);
  const date = isDate(req.query.date) ? req.query.date : res.locals.today;
  const students = roster(cls.id);
  const existing = new Map(db.get().prepare(`SELECT ar.*, u.full_name AS recorded_by_name, u2.full_name AS updated_by_name FROM attendance_records ar
    JOIN users u ON u.id = ar.recorded_by LEFT JOIN users u2 ON u2.id = ar.updated_by WHERE ar.class_id = ? AND ar.date = ?`).all(cls.id, date).map((x) => [x.student_id, x]));
  const corrections = db.get().prepare(`SELECT COUNT(*) n FROM audit_log al JOIN attendance_records ar ON ar.id = al.entity_id
    WHERE al.entity = 'attendance' AND al.action = 'update' AND ar.class_id = ? AND ar.date = ?`).get(cls.id, date).n;
  const closure = db.get().prepare('SELECT * FROM closures WHERE ? BETWEEN start_date AND end_date LIMIT 1').get(date);
  res.render('attendance/take', { title: req.t('attendance.title'), cls, date, students, existing, corrections, closure, statuses: STATUSES });
});

r.post('/attendance/:classId', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  const cls = year && classRow(int(req.params.classId), year.id);
  if (!cls || !access.canTakeAttendance(req.user, cls.id)) return auth.notFound(req, res);
  const date = str(req.body.date, 10);
  if (!isDate(date) || date > res.locals.today) {
    res.flash('error', 'attendance.badDate');
    return res.redirect(`/attendance/${cls.id}`);
  }
  const settings = db.getSettings();
  const alertStatuses = settings.absence_alert_statuses.split(',');
  const students = roster(cls.id);
  const d = db.get();
  const getRec = d.prepare('SELECT * FROM attendance_records WHERE class_id = ? AND student_id = ? AND date = ?');
  const guardians = d.prepare('SELECT parent_user_id FROM guardians WHERE student_id = ?');
  let changed = 0;
  d.transaction(() => {
    for (const st of students) {
      const status = str(req.body[`s_${st.id}`], 20);
      if (!STATUSES.includes(status)) continue; // skipped rows stay unrecorded
      const note = str(req.body[`n_${st.id}`], 300) || null;
      const prev = getRec.get(cls.id, st.id, date);
      let recId;
      if (!prev) {
        recId = Number(d.prepare('INSERT INTO attendance_records (class_id, student_id, date, status, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(cls.id, st.id, date, status, note, req.user.id).lastInsertRowid);
        db.audit({ entity: 'attendance', entityId: recId, action: 'create', userId: req.user.id, after: { status, note } });
        changed++;
      } else if (prev.status !== status || (prev.note || null) !== note) {
        recId = prev.id;
        d.prepare("UPDATE attendance_records SET status = ?, note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(status, note, req.user.id, prev.id);
        db.audit({ entity: 'attendance', entityId: prev.id, action: 'update', userId: req.user.id, before: { status: prev.status, note: prev.note }, after: { status, note } });
        changed++;
      } else continue;
      // Parent alerts, if the school has turned them on. Unique keys stop duplicates.
      if (alertStatuses.includes(status) && (!prev || prev.status !== status)) {
        for (const g of guardians.all(st.id)) {
          if (settings.parent_absence_alert === 'in_app') {
            d.prepare('INSERT OR IGNORE INTO notifications (user_id, kind, data, source) VALUES (?, ?, ?, ?)')
              .run(g.parent_user_id, 'absence', JSON.stringify({ student: st.full_name, status, date, class: cls.name }), `attendance:${recId}:${status}`);
          }
          if (settings.prepare_sms_for_absences === '1') {
            const body = `${settings.school_name}: ${st.full_name} — ${status} — ${date}`;
            d.prepare("INSERT OR IGNORE INTO message_outbox (channel, recipient_user_id, body, source) VALUES ('sms', ?, ?, ?)").run(g.parent_user_id, body, `attendance:${recId}:${status}`);
          }
        }
      }
    }
  })();
  res.flash('ok', changed ? 'attendance.saved' : 'common.noChanges');
  res.redirect(`/attendance/${cls.id}?date=${date}`);
});

// Who changed what, and when.
r.get('/attendance/:classId/history', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  const cls = year && classRow(int(req.params.classId), year.id);
  if (!cls || !access.canTakeAttendance(req.user, cls.id)) return auth.notFound(req, res);
  const date = isDate(req.query.date) ? req.query.date : null;
  const rows = db.get().prepare(`SELECT al.*, u.full_name, st.full_name AS student_name, ar.date FROM audit_log al
    JOIN attendance_records ar ON ar.id = al.entity_id JOIN students st ON st.id = ar.student_id LEFT JOIN users u ON u.id = al.user_id
    WHERE al.entity = 'attendance' AND ar.class_id = ? AND (? IS NULL OR ar.date = ?) ORDER BY al.id DESC LIMIT 300`).all(cls.id, date, date);
  rows.forEach((h) => { h.before = h.before_json && JSON.parse(h.before_json); h.after = h.after_json && JSON.parse(h.after_json); });
  res.render('attendance/history', { title: req.t('attendance.historyTitle'), cls, rows, date });
});

// Printable paper register for one week, so the school can keep working without devices.
r.get('/attendance/:classId/print', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  const cls = year && classRow(int(req.params.classId), year.id);
  if (!cls || !access.canTakeAttendance(req.user, cls.id)) return auth.notFound(req, res);
  let start = isDate(req.query.week) ? req.query.week : res.locals.today;
  const dow = new Date(`${start}T00:00:00Z`).getUTCDay();
  start = addDays(start, dow === 0 ? -6 : 1 - dow);
  const days = [0, 1, 2, 3, 4, 5].map((i) => addDays(start, i));
  const students = roster(cls.id);
  const recs = db.get().prepare('SELECT student_id, date, status FROM attendance_records WHERE class_id = ? AND date BETWEEN ? AND ?').all(cls.id, days[0], days[5]);
  const marks = new Map(recs.map((x) => [`${x.student_id}|${x.date}`, x.status]));
  res.render('attendance/print', { title: req.t('attendance.registerTitle'), cls, days, students, marks, layout: 'print' });
});

r.get('/attendance/:classId/export.csv', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  const cls = year && classRow(int(req.params.classId), year.id);
  if (!cls || !access.canTakeAttendance(req.user, cls.id)) return auth.notFound(req, res);
  const from = isDate(req.query.from) ? req.query.from : year.start_date;
  const to = isDate(req.query.to) ? req.query.to : year.end_date;
  const t = req.t;
  const rows = db.get().prepare(`SELECT ar.date, st.student_number, st.full_name, ar.status, ar.note, u.full_name AS by_name
    FROM attendance_records ar JOIN students st ON st.id = ar.student_id JOIN users u ON u.id = ar.recorded_by
    WHERE ar.class_id = ? AND ar.date BETWEEN ? AND ? ORDER BY ar.date, st.full_name`).all(cls.id, from, to);
  res.type('text/csv; charset=utf-8').attachment(`attendance-${cls.name.replace(/[^\w-]+/g, '_')}-${from}-${to}.csv`);
  res.send(toCsv([t('common.date'), t('students.number'), t('students.name'), t('attendance.status'), t('common.note'), t('common.recordedBy')],
    rows.map((x) => [x.date, x.student_number, x.full_name, t(`attendance.st.${x.status}`), x.note, x.by_name])));
});

module.exports = r;
