'use strict';
// Administration: Teaching assignments and timetable.
// Moved unchanged from the former src/routes/admin.js. Admin role is required (see index.js).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const { int, str, isTime, minutesBetween } = require('../../util');
const { back } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
/* ---------- Teaching assignments and timetable ---------- */

r.get('/admin/timetable', (req, res) => {
  const year = res.locals.year;
  if (!year) return back(res, '/admin/structure', 'info', 'admin.createYearFirst');
  const d = db.get();
  const classId = int(req.query.class);
  const classes = d.prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  const terms = d.prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(year.id);
  const assignments = d.prepare(`SELECT ta.*, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    WHERE c.year_id = ? AND (? IS NULL OR c.id = ?) ORDER BY c.name, s.name_en`).all(year.id, classId, classId);
  const slotStmt = d.prepare('SELECT ts.*, t.name AS term_name FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id WHERE ts.assignment_id = ? ORDER BY t.ordinal, ts.day_of_week, ts.start_time');
  assignments.forEach((a) => { a.slots = slotStmt.all(a.id); });
  res.render('admin/timetable', {
    title: req.t('admin.timetable'), classes, classId, terms, assignments,
    teachers: d.prepare("SELECT id, full_name FROM users WHERE role = 'teacher' AND active = 1 ORDER BY full_name").all(),
    subjects: d.prepare('SELECT * FROM subjects WHERE active = 1 ORDER BY name_en').all(),
  });
});

r.post('/admin/assignments', (req, res) => {
  const year = res.locals.year;
  const v = { teacher_id: int(req.body.teacher_id), class_id: int(req.body.class_id), subject_id: int(req.body.subject_id) };
  const url = `/admin/timetable?class=${v.class_id || ''}`;
  const ok = v.teacher_id && v.class_id && v.subject_id
    && db.get().prepare("SELECT 1 FROM users WHERE id = ? AND role = 'teacher'").get(v.teacher_id)
    && db.get().prepare('SELECT 1 FROM classes WHERE id = ? AND year_id = ?').get(v.class_id, year.id)
    && db.get().prepare('SELECT 1 FROM subjects WHERE id = ?').get(v.subject_id);
  if (!ok) return back(res, url, 'error', 'validation.checkFields');
  const info = db.get().prepare('INSERT OR IGNORE INTO teaching_assignments (teacher_id, class_id, subject_id) VALUES (@teacher_id, @class_id, @subject_id)').run(v);
  if (info.changes) db.audit({ entity: 'teaching_assignment', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, url, info.changes ? 'ok' : 'info', info.changes ? 'common.saved' : 'admin.duplicate');
});

r.post('/admin/slots', (req, res) => {
  const v = { assignment_id: int(req.body.assignment_id), term_id: int(req.body.term_id), day_of_week: int(req.body.day_of_week), start_time: str(req.body.start_time, 5), end_time: str(req.body.end_time, 5), room: str(req.body.room, 40) || null };
  const a = db.get().prepare('SELECT * FROM teaching_assignments WHERE id = ?').get(v.assignment_id);
  const url = `/admin/timetable?class=${a ? a.class_id : ''}#a-${v.assignment_id}`;
  if (!a || !v.term_id || !(v.day_of_week >= 1 && v.day_of_week <= 7) || !isTime(v.start_time) || !isTime(v.end_time) || minutesBetween(v.start_time, v.end_time) <= 0) {
    return back(res, url, 'error', 'validation.checkFields');
  }
  // Warn about clashes: same teacher or same class at an overlapping time in the same term.
  const clash = db.get().prepare(`SELECT 1 FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id
    WHERE ts.term_id = @term_id AND ts.day_of_week = @day_of_week AND ts.start_time < @end_time AND ts.end_time > @start_time
    AND (ta.teacher_id = @teacher_id OR ta.class_id = @class_id) LIMIT 1`).get({ ...v, teacher_id: a.teacher_id, class_id: a.class_id });
  if (clash) return back(res, url, 'error', 'admin.slotClash');
  const info = db.get().prepare('INSERT INTO timetable_slots (assignment_id, term_id, day_of_week, start_time, end_time, room) VALUES (@assignment_id, @term_id, @day_of_week, @start_time, @end_time, @room)').run(v);
  db.audit({ entity: 'timetable_slot', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, url, 'ok', 'common.saved');
});

r.post('/admin/slots/:id/delete', (req, res) => {
  const s = db.get().prepare('SELECT ts.*, ta.class_id FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id WHERE ts.id = ?').get(int(req.params.id));
  if (!s) return auth.notFound(req, res);
  const url = `/admin/timetable?class=${s.class_id}#a-${s.assignment_id}`;
  // Recorded sessions keep pointing at the slot, so a used slot cannot be removed.
  if (db.get().prepare('SELECT 1 FROM class_sessions WHERE slot_id = ?').get(s.id)) return back(res, url, 'error', 'admin.slotInUse');
  db.get().prepare('DELETE FROM timetable_slots WHERE id = ?').run(s.id);
  db.audit({ entity: 'timetable_slot', entityId: s.id, action: 'delete', userId: req.user.id, before: s });
  back(res, url, 'ok', 'common.deleted');
});

module.exports = r;
