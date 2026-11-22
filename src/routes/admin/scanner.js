'use strict';
// Administration: fingerprint scanners for teacher attendance.
//   /admin/scanner        set-up: devices, staff numbers, rules, USB file upload, test scans
//   /admin/scanner/board  today's lessons as the scans show them, plus what needs a decision
// Admin role is required (see index.js). Every decision needs a reason and is written to the
// audit log. Scans themselves can never be changed or deleted (database triggers).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const config = require('../../config');
const scanner = require('../../scanner');
const { int, str, isDate, isTime } = require('../../util');
const { back } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));

const PIN = /^[0-9]{1,9}$/;
const IP = /^[0-9a-fA-F:.]{3,45}$/;
const RULES = {
  scanner_grace_min: [0, 60], scanner_late_limit_min: [1, 120], scanner_early_min: [0, 60],
  scanner_exit_wait_min: [5, 180], scanner_double_scan_min: [0, 10], scanner_back_to_back_min: [0, 30],
};
const testScansAllowed = () => !config.get().production || db.getSettings().demo_mode === '1';

function setupData() {
  const d = db.get();
  return {
    devices: d.prepare('SELECT * FROM scan_devices ORDER BY status = \'pending\' DESC, name').all(),
    teachers: d.prepare(`SELECT u.id, u.full_name, u.scanner_pin,
        (SELECT MAX(scanned_at) FROM scans WHERE user_id = u.id) AS last_scan
      FROM users u WHERE u.role = 'teacher' AND u.active = 1 ORDER BY u.full_name`).all(),
    unknownPins: d.prepare('SELECT pin, COUNT(*) n, MAX(scanned_at) last FROM scans WHERE user_id IS NULL GROUP BY pin ORDER BY last DESC LIMIT 20').all(),
    testAllowed: testScansAllowed(),
  };
}

r.get('/admin/scanner', (req, res) => {
  res.render('admin/scanner', { title: req.t('scanner.setupTitle'), ...setupData(), errors: [], log: '', uploadResult: null });
});

r.post('/admin/scanner/devices/:id', (req, res) => {
  const d = db.get();
  const dev = d.prepare('SELECT * FROM scan_devices WHERE id = ?').get(int(req.params.id));
  if (!dev) return auth.notFound(req, res);
  const action = str(req.body.action, 20);
  const next = { name: str(req.body.name, 60) || dev.name, allowed_ip: str(req.body.allowed_ip, 45) || null, status: dev.status };
  if (next.allowed_ip && !IP.test(next.allowed_ip)) return back(res, '/admin/scanner#devices', 'error', 'validation.checkFields');
  if (action === 'approve') next.status = 'active';
  else if (action === 'disable') next.status = 'disabled';
  d.transaction(() => {
    d.prepare('UPDATE scan_devices SET name = ?, allowed_ip = ?, status = ? WHERE id = ?').run(next.name, next.allowed_ip, next.status, dev.id);
    if (action === 'approve') {
      d.prepare("UPDATE scan_devices SET approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(req.user.id, dev.id);
      // Lessons with no scan count as missed only from the day the first scanner was approved.
      if (!db.getSettings().scanner_start_date) db.setSetting('scanner_start_date', res.locals.today);
    }
    db.audit({ entity: 'scan_device', entityId: dev.id, action: action || 'update', userId: req.user.id,
      before: { name: dev.name, allowed_ip: dev.allowed_ip, status: dev.status }, after: next });
  })();
  if (action === 'approve') scanner.recomputeDate(res.locals.today);
  back(res, '/admin/scanner#devices', 'ok', 'common.saved');
});

// Staff numbers: one field per teacher, "pin_<user id>".
r.post('/admin/scanner/pins', (req, res) => {
  const d = db.get();
  const teachers = d.prepare("SELECT id, full_name, scanner_pin FROM users WHERE role = 'teacher' AND active = 1").all();
  const wanted = new Map();
  for (const tch of teachers) {
    const v = str(req.body[`pin_${tch.id}`], 9).replace(/^0+(?=\d)/, '');
    if (v && !PIN.test(v)) return back(res, '/admin/scanner#pins', 'error', 'scanner.pinInvalid');
    if (v && [...wanted.values()].includes(v)) return back(res, '/admin/scanner#pins', 'error', 'scanner.pinDuplicate');
    wanted.set(tch.id, v || null);
  }
  for (const [id, pin] of wanted) {
    if (pin && d.prepare("SELECT 1 FROM users WHERE scanner_pin = ? AND id != ? AND (role != 'teacher' OR active = 0)").get(pin, id)) {
      return back(res, '/admin/scanner#pins', 'error', 'scanner.pinDuplicate');
    }
  }
  let changed = 0;
  d.transaction(() => {
    // Clear first, so two teachers can swap numbers in one save.
    for (const tch of teachers) if ((tch.scanner_pin || null) !== wanted.get(tch.id)) d.prepare('UPDATE users SET scanner_pin = NULL WHERE id = ?').run(tch.id);
    for (const tch of teachers) {
      const pin = wanted.get(tch.id);
      if ((tch.scanner_pin || null) === pin) continue;
      scanner.setPin(tch.id, pin);
      db.audit({ entity: 'user', entityId: tch.id, action: 'scanner_pin', userId: req.user.id, before: { scanner_pin: tch.scanner_pin }, after: { scanner_pin: pin } });
      changed++;
    }
  })();
  back(res, '/admin/scanner#pins', changed ? 'ok' : 'info', changed ? 'common.saved' : 'common.noChanges');
});

r.post('/admin/scanner/rules', (req, res) => {
  const before = db.getSettings();
  const next = {};
  for (const [key, [lo, hi]] of Object.entries(RULES)) {
    const v = int(req.body[key]);
    if (v === null || v < lo || v > hi) return back(res, '/admin/scanner#rules', 'error', 'validation.checkFields');
    next[key] = String(v);
  }
  next.scanner_lock_manual = req.body.scanner_lock_manual === '1' ? '1' : '0';
  db.get().transaction(() => {
    for (const [k, v] of Object.entries(next)) db.setSetting(k, v);
    const b = {}; for (const k of Object.keys(next)) b[k] = before[k];
    db.audit({ entity: 'settings', action: 'scanner_rules', userId: req.user.id, before: b, after: next });
  })();
  back(res, '/admin/scanner#rules', 'ok', 'common.saved');
});

// Attendance file copied from the device with a USB stick (1_attlog.dat), pasted or read by the page.
r.post('/admin/scanner/upload', (req, res) => {
  const text = String(req.body.log || '');
  const { scans, skipped } = scanner.parseLog(text);
  if (!scans.length) {
    return res.status(400).render('admin/scanner', { title: req.t('scanner.setupTitle'), ...setupData(), errors: [{ key: 'scanner.uploadEmpty' }], log: text.slice(0, 20000), uploadResult: null });
  }
  const result = scanner.addScans(scans, { source: 'file', receivedBy: req.user.id });
  db.audit({ entity: 'scans', action: 'upload', userId: req.user.id, after: { lines: scans.length, added: result.added, duplicates: result.duplicates, skipped } });
  res.render('admin/scanner', { title: req.t('scanner.setupTitle'), ...setupData(), errors: [], log: '', uploadResult: { ...result, skipped } });
});

// A scan typed by hand, to try the portal before the device arrives. Not on a real school site.
r.post('/admin/scanner/test-scan', (req, res) => {
  if (!testScansAllowed()) return auth.forbidden(req, res);
  const pin = str(req.body.pin, 9);
  const date = str(req.body.date, 10);
  const time = str(req.body.time, 5);
  if (!PIN.test(pin) || !isDate(date) || !isTime(time)) return back(res, '/admin/scanner#test', 'error', 'validation.checkFields');
  const result = scanner.addScans([{ pin, scanned_at: `${date} ${time}:00` }], { source: 'test', receivedBy: req.user.id });
  db.audit({ entity: 'scans', action: 'test_scan', userId: req.user.id, after: { pin, at: `${date} ${time}` } });
  back(res, `/admin/scanner/board?date=${date}`, result.added ? 'ok' : 'info', result.added ? 'scanner.testAdded' : 'scanner.duplicate');
});

/* ---------- Board ---------- */

r.get('/admin/scanner/board', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : res.locals.today;
  if (date <= res.locals.today) scanner.recomputeDate(date);
  const d = db.get();
  const rows = scanner.board(date);
  const corrections = d.prepare(`SELECT sc.*, u.full_name, ts.start_time, ts.end_time, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr
    FROM scan_corrections sc JOIN users u ON u.id = sc.user_id JOIN timetable_slots ts ON ts.id = sc.slot_id
    JOIN teaching_assignments ta ON ta.id = ts.assignment_id JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
    WHERE sc.status = 'pending' ORDER BY sc.date, ts.start_time`).all();
  const review = d.prepare(`SELECT sl.*, u.full_name, ts.start_time, ts.end_time, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr
    FROM scan_lessons sl JOIN users u ON u.id = sl.user_id JOIN timetable_slots ts ON ts.id = sl.slot_id
    JOIN teaching_assignments ta ON ta.id = ts.assignment_id JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
    WHERE sl.decision = 'auto' AND sl.state IN ('review','unconfirmed') AND sl.date <= ? ORDER BY sl.date DESC, ts.start_time LIMIT 100`).all(res.locals.today);
  const devices = d.prepare("SELECT * FROM scan_devices WHERE status != 'disabled' ORDER BY name").all();
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
  res.render('admin/scan-board', {
    title: req.t('scanner.boardTitle'), date, rows, counts, corrections, review, unmatched: scanner.unmatched(date), devices,
    rules: scanner.rules(),
  });
});

const boardUrl = (date) => `/admin/scanner/board?date=${isDate(date) ? date : ''}`;

r.post('/admin/scanner/lessons/decide', (req, res) => {
  const slotId = int(req.body.slot_id);
  const date = str(req.body.date, 10);
  const decision = str(req.body.decision, 10);
  const reason = str(req.body.reason, 500);
  const slot = slotId && scanner.slotById(slotId);
  if (!slot || !isDate(date) || date > res.locals.today || !['approved', 'rejected'].includes(decision)) return back(res, boardUrl(date), 'error', 'validation.checkFields');
  if (!reason) return back(res, boardUrl(date), 'error', 'scanner.reasonRequired');
  scanner.decide({ slotId, date, decision, reason, adminId: req.user.id });
  back(res, boardUrl(date), 'ok', decision === 'approved' ? 'scanner.approvedFlash' : 'scanner.rejectedFlash');
});

r.post('/admin/scanner/scans/:id/dismiss', (req, res) => {
  const scan = db.get().prepare('SELECT * FROM scans WHERE id = ?').get(int(req.params.id));
  if (!scan) return auth.notFound(req, res);
  const date = scan.scanned_at.slice(0, 10);
  const reason = str(req.body.reason, 300);
  if (!reason) return back(res, boardUrl(date), 'error', 'scanner.reasonRequired');
  db.get().prepare('INSERT OR IGNORE INTO scan_dismissals (scan_id, user_id, reason) VALUES (?, ?, ?)').run(scan.id, req.user.id, reason);
  db.audit({ entity: 'scan', entityId: scan.id, action: 'dismiss', userId: req.user.id, reason });
  back(res, boardUrl(date), 'ok', 'common.saved');
});

r.post('/admin/scanner/corrections/:id', (req, res) => {
  const d = db.get();
  const c = d.prepare('SELECT * FROM scan_corrections WHERE id = ?').get(int(req.params.id));
  if (!c) return auth.notFound(req, res);
  const url = boardUrl(c.date);
  if (c.status !== 'pending') return back(res, url, 'info', 'scanner.alreadyHandled');
  const decision = str(req.body.decision, 10);
  const note = str(req.body.admin_note, 500);
  if (!['approved', 'rejected'].includes(decision)) return back(res, url, 'error', 'validation.checkFields');
  if (decision === 'rejected' && !note) return back(res, url, 'error', 'scanner.reasonRequired');
  d.transaction(() => {
    d.prepare("UPDATE scan_corrections SET status = ?, admin_note = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?").run(decision, note || null, req.user.id, c.id);
    db.audit({ entity: 'scan_correction', entityId: c.id, action: decision, userId: req.user.id, reason: note || c.reason });
    if (decision === 'approved') {
      scanner.decide({ slotId: c.slot_id, date: c.date, decision: 'approved', reason: `${req.t('scanner.correctionBy')}: ${c.reason}${note ? ` (${note})` : ''}`.slice(0, 500), adminId: req.user.id, source: 'correction' });
    }
  })();
  back(res, url, 'ok', decision === 'approved' ? 'scanner.approvedFlash' : 'scanner.rejectedFlash');
});

module.exports = r;
