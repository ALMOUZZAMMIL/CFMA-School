'use strict';
// A teacher's own fingerprint scans and the lessons they recorded, read only. A teacher can
// never change a scan or a scanned lesson: when something is wrong (forgot to scan, scanner
// down) they send a correction request, and an administrator decides.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const scanner = require('../scanner');
const { int, str, isDate, addDays } = require('../util');

const r = express.Router();
r.use('/my-scans', auth.requireRole('teacher'));

const DAYS_BACK = 14;

r.get('/my-scans', auth.requireRole('teacher'), (req, res) => {
  const today = res.locals.today;
  const from = addDays(today, -DAYS_BACK);
  const date = isDate(req.query.date) && req.query.date >= from && req.query.date <= today ? req.query.date : today;
  scanner.recompute(req.user.id, date);
  const d = db.get();
  const lessons = scanner.lessonsFor({ userId: req.user.id, date });
  // Where the teacher should be now (or next), so a scan always leads to the right class.
  let current = null; let next = null;
  if (date === today) {
    const now = scanner.nowIn(res.locals.settings.timezone).time.slice(0, 5);
    current = lessons.find((l) => l.start_time <= now && now < l.end_time) || null;
    next = lessons.find((l) => l.start_time > now) || null;
  }
  res.render('scans/mine', {
    title: req.t('scanner.myTitle'), date, from, lessons, current, next,
    pin: d.prepare('SELECT scanner_pin FROM users WHERE id = ?').get(req.user.id).scanner_pin,
    scans: d.prepare(`SELECT sc.scanned_at, sc.source, dv.name AS device_name FROM scans sc LEFT JOIN scan_devices dv ON dv.id = sc.device_id
      WHERE sc.user_id = ? AND sc.scanned_at >= ? ORDER BY sc.scanned_at DESC LIMIT 200`).all(req.user.id, `${from} 00:00:00`),
    requests: d.prepare(`SELECT sc.*, ts.start_time, ts.end_time, c.name AS class_name FROM scan_corrections sc
      JOIN timetable_slots ts ON ts.id = sc.slot_id JOIN teaching_assignments ta ON ta.id = ts.assignment_id JOIN classes c ON c.id = ta.class_id
      WHERE sc.user_id = ? ORDER BY sc.created_at DESC LIMIT 30`).all(req.user.id),
  });
});

r.post('/my-scans/corrections', auth.requireRole('teacher'), (req, res) => {
  const today = res.locals.today;
  const date = str(req.body.date, 10);
  const slotId = int(req.body.slot_id);
  const reason = str(req.body.reason, 500);
  const url = `/my-scans?date=${isDate(date) ? date : ''}`;
  const slot = slotId && scanner.slotById(slotId);
  // Only the teacher's own lesson, on a day it is timetabled, in the last two weeks.
  const ok = slot && slot.teacher_id === req.user.id && isDate(date) && date <= today && date >= addDays(today, -DAYS_BACK)
    && scanner.slotsFor(req.user.id, date).some((s) => s.id === slotId);
  if (!ok) return auth.notFound(req, res);
  if (!reason) { res.flash('error', 'scanner.reasonRequired'); return res.redirect(url); }
  const d = db.get();
  if (d.prepare("SELECT 1 FROM scan_corrections WHERE user_id = ? AND slot_id = ? AND date = ? AND status = 'pending'").get(req.user.id, slotId, date)) {
    res.flash('info', 'scanner.requestPending'); return res.redirect(url);
  }
  const info = d.prepare('INSERT INTO scan_corrections (user_id, slot_id, date, reason) VALUES (?, ?, ?, ?)').run(req.user.id, slotId, date, reason);
  db.audit({ entity: 'scan_correction', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, reason, after: { slot_id: slotId, date } });
  res.flash('ok', 'scanner.requestSent');
  res.redirect(url);
});

module.exports = r;
