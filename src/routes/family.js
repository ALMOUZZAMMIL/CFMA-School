'use strict';
// Student and parent views. A parent only ever sees children linked to their account.
const express = require('express');
const db = require('../db');
const access = require('../access');
const auth = require('../auth');
const reports = require('../reports');
const { int, isDate } = require('../util');

const r = express.Router();

r.get('/me', auth.requireRole('student'), (req, res) => {
  const ids = access.visibleStudentIds(req.user);
  if (!ids.length) return res.render('error', { title: req.t('students.noRecordTitle'), message: req.t('students.noRecord') });
  res.redirect(`/students/${ids[0]}`);
});

r.get('/students/:id', (req, res) => {
  const id = int(req.params.id);
  if (!id || !access.canViewStudent(req.user, id)) return auth.notFound(req, res);
  const year = res.locals.year;
  const st = db.get().prepare('SELECT * FROM students WHERE id = ?').get(id);
  const cls = year ? access.studentClass(id, year.id) : null;
  const settings = res.locals.settings;
  const family = req.user.role === 'parent' || req.user.role === 'student';
  const showAttendance = !family || (req.user.role === 'parent' ? settings.show_attendance_to_parents === '1' : settings.show_attendance_to_students === '1');
  const showProgress = !family || settings.show_progress_to_students === '1';
  let attendance = null;
  let summary = null;
  if (showAttendance && year) {
    const from = isDate(req.query.from) ? req.query.from : year.start_date;
    attendance = db.get().prepare(`SELECT ar.date, ar.status, ar.note, c.name AS class_name FROM attendance_records ar JOIN classes c ON c.id = ar.class_id
      WHERE ar.student_id = ? AND ar.date >= ? AND ar.status != 'present' ORDER BY ar.date DESC LIMIT 60`).all(id, from);
    summary = db.get().prepare(`SELECT COUNT(*) total, SUM(status='present') present, SUM(status='absent') absent, SUM(status='late') late, SUM(status='excused') excused
      FROM attendance_records WHERE student_id = ? AND date BETWEEN ? AND ?`).get(id, year.start_date, year.end_date);
  }
  let progress = [];
  if (showProgress && cls) {
    const list = db.get().prepare(`SELECT ta.*, c.level, c.section_id, c.year_id, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
      FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
      WHERE ta.class_id = ? ORDER BY s.name_en`).all(cls.id);
    progress = list.map((a) => ({ a, p: reports.progressFor(a, res.locals.today) }));
  }
  const guardians = req.user.role === 'admin' ? db.get().prepare(`SELECT u.id, u.full_name, u.phone, g.relationship FROM guardians g JOIN users u ON u.id = g.parent_user_id WHERE g.student_id = ?`).all(id) : [];
  res.render('students/view', { title: st.full_name, st, cls, attendance, summary, progress, showAttendance, showProgress, guardians });
});

module.exports = r;
