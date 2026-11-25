'use strict';
// Fingerprint scanner attendance for teachers.
//
// A teacher scans before going to class and again when coming back. This file turns those
// scans into lessons: it matches each teacher's scans of a day against their timetable slots,
// stores the result per slot (scan_lessons), and records finished lessons in class_sessions,
// so the existing hours report counts them. The matching itself (matchDay) is a pure function,
// tested on its own. See docs/fingerprint-scanner.md for the rules in plain words.
const db = require('./db');
const { weekday, isDate, demoClock } = require('./util');

const RULE_KEYS = {
  grace: 'scanner_grace_min',
  lateLimit: 'scanner_late_limit_min',
  early: 'scanner_early_min',
  exitWait: 'scanner_exit_wait_min',
  double: 'scanner_double_scan_min',
  backToBack: 'scanner_back_to_back_min',
};

function rules(settings = db.getSettings()) {
  const out = {};
  for (const [k, key] of Object.entries(RULE_KEYS)) out[k] = Number(settings[key]) || 0;
  return out;
}

// 'HH:MM' or 'YYYY-MM-DD HH:MM[:SS]' to minutes after midnight (seconds as a fraction).
function toMin(s) {
  const t = s.length > 8 ? s.slice(11) : s;
  const [h, m, sec] = t.split(':').map(Number);
  return h * 60 + m + (sec || 0) / 60;
}
const hhmm = (s) => (s ? (s.length > 8 ? s.slice(11, 16) : s.slice(0, 5)) : null);

// Current date and time in the school's time zone. The static demo export freezes the clock
// at a school-day morning (DEMO_CLOCK='YYYY-MM-DD HH:MM'), never on a production server.
function nowIn(timezone) {
  const demo = demoClock();
  if (demo) return { date: demo.slice(0, 10), time: `${demo.slice(11, 16)}:00` };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

/**
 * Matches one teacher's scans of one day against that day's timetable slots.
 *   slots: [{ id, start_time 'HH:MM', end_time 'HH:MM' }]
 *   scans: [{ id, scanned_at 'YYYY-MM-DD HH:MM:SS' }]
 *   nowMin: minutes after midnight now (Infinity for a past day, -Infinity for a future day)
 * Returns { lessons: [{ slotId, state, inScan, outScan, lateMin, earlyMin }], usedScanIds: Set }
 * state: waiting | in_class | done | unconfirmed | review | no_scan
 */
function matchDay({ slots, scans, nowMin, rules: r }) {
  // Lessons at the same time (a teacher timetabled with several classes at once) are one period.
  const periods = new Map();
  for (const sl of slots) {
    const k = `${sl.start_time}|${sl.end_time}`;
    if (!periods.has(k)) periods.set(k, { ...sl, members: [] });
    periods.get(k).members.push(sl);
  }
  const res = matchPeriods({ slots: [...periods.values()], scans, nowMin, rules: r });
  const lessons = [];
  for (const l of res.lessons) for (const sl of l.slot.members) lessons.push({ ...l, slotId: sl.id, slot: sl });
  return { lessons, usedScanIds: res.usedScanIds };
}

function matchPeriods({ slots, scans, nowMin, rules: r }) {
  const ordered = [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time));
  // Two scans close together (a double tap) count as one.
  const points = [];
  for (const s of [...scans].sort((a, b) => a.scanned_at.localeCompare(b.scanned_at))) {
    const min = toMin(s.scanned_at);
    const last = points[points.length - 1];
    if (last && min - last.min < r.double) { last.ids.push(s.id); continue; }
    points.push({ scan: s, min, ids: [s.id] });
  }
  const used = new Set();
  const lessons = [];
  let chain = []; // lessons covered by one scan out, waiting for the scan back
  let cursor = 0; // index of the first point a new lesson may start from
  let chainIn = null;

  const closeChain = (outPoint) => {
    if (!chain.length) return;
    const last = chain[chain.length - 1];
    for (const l of chain) {
      if (outPoint) {
        l.outScan = outPoint.scan;
        if (l === last) l.earlyMin = Math.max(0, Math.round(toMin(l.slot.end_time) - outPoint.min));
        l.state = l.lateMin > r.lateLimit ? 'review' : 'done';
      } else {
        l.state = l.lateMin > r.lateLimit ? 'review' : (nowMin <= toMin(last.slot.end_time) + r.exitWait ? 'in_class' : 'unconfirmed');
      }
    }
    chain = [];
    chainIn = null;
  };

  ordered.forEach((slot, i) => {
    const st = toMin(slot.start_time);
    const en = toMin(slot.end_time);
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    const lesson = { slotId: slot.id, slot, state: 'waiting', inScan: null, outScan: null, lateMin: 0, earlyMin: 0 };
    lessons.push(lesson);

    // Still in class from the lesson just before (back-to-back, no scan in between).
    if (chain.length && prev && st - toMin(prev.end_time) <= r.backToBack) {
      lesson.inScan = chainIn.scan;
    } else {
      closeChain(null);
      // A scan close to the next lesson's start belongs to that lesson, not to a very late arrival here.
      const inEnd = next ? Math.min(en, toMin(next.start_time) - r.grace) : en;
      const k = points.findIndex((p, idx) => idx >= cursor && p.min >= st - r.grace && p.min < inEnd);
      if (k === -1) {
        lesson.state = nowMin < st + r.lateLimit ? 'waiting' : 'no_scan';
        return;
      }
      chainIn = points[k];
      cursor = k + 1;
      lesson.inScan = chainIn.scan;
      lesson.lateMin = Math.max(0, Math.round(chainIn.min - st));
      chainIn.ids.forEach((id) => used.add(id));
    }
    chain.push(lesson);

    // The scan back. With a back-to-back lesson next, a scan well into that lesson belongs to it.
    const nextIsB2B = next && toMin(next.start_time) - en <= r.backToBack;
    const limit = nextIsB2B ? Math.min(en + r.exitWait, toMin(next.start_time) + r.grace) : en + r.exitWait;
    const startIdx = points.indexOf(chainIn) + 1;
    const k = points.findIndex((p, idx) => idx >= Math.max(startIdx, cursor) && p.min <= limit);
    if (k !== -1) {
      const outPoint = points[k];
      outPoint.ids.forEach((id) => used.add(id));
      // A scan at the change of lesson ends this one and may also start a back-to-back next one.
      cursor = nextIsB2B ? k : k + 1;
      closeChain(outPoint);
    } else if (!nextIsB2B) {
      closeChain(null);
    }
  });
  closeChain(null);
  return { lessons, usedScanIds: used };
}

/* ---------- Reading data ---------- */

function slotsFor(teacherId, date) {
  if (db.get().prepare('SELECT 1 FROM closures WHERE ? BETWEEN start_date AND end_date').get(date)) return [];
  return db.get().prepare(`SELECT ts.id, ts.start_time, ts.end_time, ts.assignment_id, ts.room, ta.teacher_id, ta.class_id, c.name AS class_name,
      s.name_en AS subject_en, s.name_fr AS subject_fr
    FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id JOIN teaching_assignments ta ON ta.id = ts.assignment_id
    JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
    WHERE ta.teacher_id = ? AND ts.day_of_week = ? AND ? BETWEEN t.start_date AND t.end_date ORDER BY ts.start_time`).all(teacherId, weekday(date), date);
}

// Scans that count: from an approved device, an uploaded file, or a test scan.
function scansFor(userId, date) {
  return db.get().prepare(`SELECT sc.* FROM scans sc LEFT JOIN scan_devices dv ON dv.id = sc.device_id
    WHERE sc.user_id = ? AND sc.scanned_at >= ? AND sc.scanned_at < ? AND (sc.source != 'device' OR dv.status = 'active')
    ORDER BY sc.scanned_at`).all(userId, `${date} 00:00:00`, `${date} 99`);
}

function nowMinFor(date, settings) {
  const now = nowIn(settings.timezone);
  if (date < now.date) return Infinity;
  if (date > now.date) return -Infinity;
  return toMin(now.time);
}

// Is the scanner in use for this teacher on this date? Only then can a lesson with no scan
// be recorded as missed.
function scannerInUse(user, date, settings) {
  return !!(user && user.scanner_pin && settings.scanner_start_date && date >= settings.scanner_start_date
    && db.get().prepare("SELECT 1 FROM scan_devices WHERE status = 'active' LIMIT 1").get());
}

/* ---------- Recording lessons ---------- */

const NOTE = (l) => `Scanner: ${hhmm(l.in_time) || '—'} → ${hhmm(l.out_time) || '—'}`;

// Creates or updates the class session for a slot and date. Returns the session id.
function writeSession({ slot, date, userId, status, reason, source, actorId, why, notes }) {
  const d = db.get();
  const existing = d.prepare('SELECT * FROM class_sessions WHERE slot_id = ? AND date = ?').get(slot.id, date);
  if (existing) {
    if (existing.status === status) return existing.id;
    d.prepare("UPDATE class_sessions SET status = ?, reason = ?, source = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?")
      .run(status, reason || null, source, notes || null, existing.id);
    db.audit({ entity: 'class_session', entityId: existing.id, action: 'update', userId: actorId || null, reason: why || null,
      before: { status: existing.status, source: existing.source }, after: { status, source } });
    return existing.id;
  }
  const info = d.prepare(`INSERT INTO class_sessions (assignment_id, slot_id, date, start_time, end_time, status, reason, notes, recorded_by, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slot.assignment_id, slot.id, date, slot.start_time, slot.end_time, status, reason || null, notes || null, userId, source);
  const id = Number(info.lastInsertRowid);
  db.audit({ entity: 'class_session', entityId: id, action: 'create', userId: actorId || null, reason: why || null, after: { status, source, date, slot_id: slot.id } });
  return id;
}

/**
 * Recomputes one teacher's day from their scans, stores the result per slot and records
 * finished lessons. Admin decisions already taken are kept. Returns the lessons with details.
 */
function recompute(userId, date) {
  const d = db.get();
  const settings = db.getSettings();
  const user = d.prepare('SELECT id, scanner_pin FROM users WHERE id = ?').get(userId);
  if (!user || !isDate(date)) return [];
  const slots = slotsFor(userId, date);
  const scans = scansFor(userId, date);
  const nowMin = nowMinFor(date, settings);
  const { lessons } = matchDay({ slots, scans, nowMin, rules: rules(settings) });
  const inUse = scannerInUse(user, date, settings);
  const get = d.prepare('SELECT * FROM scan_lessons WHERE slot_id = ? AND date = ?');
  const upsert = d.prepare(`INSERT INTO scan_lessons (slot_id, date, user_id, state, in_scan_id, out_scan_id, in_time, out_time, late_min, early_min)
    VALUES (@slot_id, @date, @user_id, @state, @in_scan_id, @out_scan_id, @in_time, @out_time, @late_min, @early_min)
    ON CONFLICT(slot_id, date) DO UPDATE SET state = excluded.state, in_scan_id = excluded.in_scan_id, out_scan_id = excluded.out_scan_id,
      in_time = excluded.in_time, out_time = excluded.out_time, late_min = excluded.late_min, early_min = excluded.early_min, updated_at = datetime('now')`);
  d.transaction(() => {
    for (const l of lessons) {
      const prior = get.get(l.slotId, date);
      if (l.state === 'waiting' || (l.state === 'no_scan' && !inUse)) {
        // Nothing to store yet (or the scanner is not used for this teacher). Never drop a decision.
        if (prior && prior.decision === 'auto' && !prior.session_id) d.prepare('DELETE FROM scan_lessons WHERE id = ?').run(prior.id);
        continue;
      }
      const row = {
        slot_id: l.slotId, date, user_id: userId, state: l.state,
        in_scan_id: l.inScan ? l.inScan.id : null, out_scan_id: l.outScan ? l.outScan.id : null,
        in_time: l.inScan ? l.inScan.scanned_at : null, out_time: l.outScan ? l.outScan.scanned_at : null,
        late_min: l.lateMin, early_min: l.earlyMin,
      };
      upsert.run(row);
      const saved = get.get(l.slotId, date);
      if (saved.decision !== 'auto' || saved.session_id) continue;
      let sessionId = null;
      if (l.state === 'done') {
        sessionId = writeSession({ slot: l.slot, date, userId, status: 'held', source: 'scanner', notes: NOTE(row) });
      } else if (l.state === 'no_scan' && nowMin === Infinity) {
        // The day is over and the teacher never scanned for this lesson.
        const existing = d.prepare('SELECT id FROM class_sessions WHERE slot_id = ? AND date = ?').get(l.slotId, date);
        if (!existing) sessionId = writeSession({ slot: l.slot, date, userId, status: 'missed', reason: 'No fingerprint scan / Aucun pointage', source: 'scanner' });
      }
      if (sessionId) d.prepare('UPDATE scan_lessons SET session_id = ? WHERE id = ?').run(sessionId, saved.id);
    }
  })();
  return lessonsFor({ userId, date });
}

// Recomputes every teacher who has a staff number or scans on that date.
function recomputeDate(date) {
  const ids = db.get().prepare(`SELECT id FROM users WHERE role = 'teacher' AND (scanner_pin IS NOT NULL
    OR id IN (SELECT user_id FROM scans WHERE scanned_at >= ? AND scanned_at < ?))`).all(`${date} 00:00:00`, `${date} 99`).map((r) => r.id);
  for (const id of ids) recompute(id, date);
}

/* ---------- Views ---------- */

// Board for a date: every timetabled lesson with its scan state (teacherId optional).
function board(date, teacherId) {
  const d = db.get();
  const settings = db.getSettings();
  const nowMin = nowMinFor(date, settings);
  const r = rules(settings);
  const teachers = d.prepare(`SELECT id, full_name, scanner_pin FROM users WHERE role = 'teacher' ${teacherId ? 'AND id = ?' : ''} ORDER BY full_name`)
    .all(...(teacherId ? [teacherId] : []));
  const lessonStmt = d.prepare('SELECT * FROM scan_lessons WHERE slot_id = ? AND date = ?');
  const sessStmt = d.prepare('SELECT id, status, source FROM class_sessions WHERE slot_id = ? AND date = ?');
  const rows = [];
  for (const tch of teachers) {
    for (const slot of slotsFor(tch.id, date)) {
      const l = lessonStmt.get(slot.id, date);
      const sess = sessStmt.get(slot.id, date);
      let state = l ? l.state : (nowMin < toMin(slot.start_time) + r.lateLimit ? 'waiting' : 'no_scan');
      if (l && l.decision !== 'auto') state = l.decision;
      rows.push({ ...slot, teacher_name: tch.full_name, has_pin: !!tch.scanner_pin, lesson: l, session: sess, state,
        late: l && l.late_min > r.grace, early: l && l.early_min > r.early });
    }
  }
  return rows.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.teacher_name.localeCompare(b.teacher_name));
}

function lessonsFor({ userId, date }) { return board(date, userId); }

// Scans of a date that no lesson used and nobody has set aside yet.
function unmatched(date) {
  const d = db.get();
  const settings = db.getSettings();
  const all = d.prepare(`SELECT sc.*, u.full_name, dv.name AS device_name, dv.status AS device_status FROM scans sc
    LEFT JOIN users u ON u.id = sc.user_id LEFT JOIN scan_devices dv ON dv.id = sc.device_id
    WHERE sc.scanned_at >= ? AND sc.scanned_at < ? AND sc.id NOT IN (SELECT scan_id FROM scan_dismissals)
    ORDER BY sc.scanned_at`).all(`${date} 00:00:00`, `${date} 99`);
  const usedByUser = new Map();
  const out = [];
  for (const s of all) {
    if (s.source === 'device' && s.device_status !== 'active') continue;
    if (!s.user_id) { out.push({ ...s, why: 'unknown_pin' }); continue; }
    if (!usedByUser.has(s.user_id)) {
      const res = matchDay({ slots: slotsFor(s.user_id, date), scans: scansFor(s.user_id, date), nowMin: nowMinFor(date, settings), rules: rules(settings) });
      usedByUser.set(s.user_id, res.usedScanIds);
    }
    if (!usedByUser.get(s.user_id).has(s.id)) out.push({ ...s, why: 'no_lesson' });
  }
  return out;
}

/* ---------- Receiving scans ---------- */

// One line of a ZKTeco attendance log, from the device (ADMS "ATTLOG") or a USB file
// (1_attlog.dat): staff number, then date and time, separated by tabs, commas or spaces.
const LINE = /^\s*"?([A-Za-z0-9]{1,20})"?\s*[\t,;]?\s*"?(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
function parseLog(text) {
  const scans = [];
  let skipped = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(LINE);
    if (!m) { skipped++; continue; }
    const at = `${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}:${m[7] || '00'}`;
    if (!isDate(at.slice(0, 10)) || Number(m[5]) > 23 || Number(m[6]) > 59 || Number(m[7] || 0) > 59) { skipped++; continue; }
    scans.push({ pin: m[1].replace(/^0+(?=\d)/, ''), scanned_at: at });
  }
  return { scans, skipped };
}

/**
 * Stores scans (duplicates are ignored) and recomputes the teachers and days they touch.
 * Returns { added, duplicates }.
 */
function addScans(list, { deviceId = null, source, receivedBy = null }) {
  const d = db.get();
  const pinUser = d.prepare("SELECT id FROM users WHERE scanner_pin = ? AND role = 'teacher'");
  const ins = d.prepare('INSERT OR IGNORE INTO scans (device_id, pin, user_id, scanned_at, source, received_by) VALUES (?, ?, ?, ?, ?, ?)');
  const touched = new Set();
  let added = 0;
  d.transaction(() => {
    for (const s of list) {
      const u = pinUser.get(s.pin);
      const info = ins.run(deviceId, s.pin, u ? u.id : null, s.scanned_at, source, receivedBy);
      if (info.changes) { added++; if (u) touched.add(`${u.id}|${s.scanned_at.slice(0, 10)}`); }
    }
  })();
  for (const k of touched) { const [uid, date] = k.split('|'); recompute(Number(uid), date); }
  return { added, duplicates: list.length - added };
}

// Links a staff number to a teacher and gives them the scans already received with that number.
function setPin(userId, pin) {
  const d = db.get();
  d.prepare('UPDATE users SET scanner_pin = ? WHERE id = ?').run(pin || null, userId);
  if (!pin) return 0;
  const dates = d.prepare('SELECT DISTINCT substr(scanned_at, 1, 10) AS date FROM scans WHERE pin = ? AND user_id IS NULL').all(pin).map((r) => r.date);
  d.prepare('UPDATE scans SET user_id = ? WHERE pin = ? AND user_id IS NULL').run(userId, pin);
  for (const date of dates) recompute(userId, date);
  return dates.length;
}

/* ---------- Admin decisions ---------- */

function slotById(id) {
  return db.get().prepare('SELECT ts.*, ta.teacher_id FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id WHERE ts.id = ?').get(id);
}

// approve: the lesson counts as taught. reject: it is recorded as missed.
function decide({ slotId, date, decision, reason, adminId, source = 'scanner' }) {
  const d = db.get();
  const slot = slotById(slotId);
  if (!slot) return null;
  return d.transaction(() => {
    let l = d.prepare('SELECT * FROM scan_lessons WHERE slot_id = ? AND date = ?').get(slotId, date);
    if (!l) {
      d.prepare("INSERT INTO scan_lessons (slot_id, date, user_id, state) VALUES (?, ?, ?, 'no_scan')").run(slotId, date, slot.teacher_id);
      l = d.prepare('SELECT * FROM scan_lessons WHERE slot_id = ? AND date = ?').get(slotId, date);
    }
    const sessionId = writeSession({
      slot, date, userId: slot.teacher_id, actorId: adminId, why: reason, source,
      status: decision === 'approved' ? 'held' : 'missed',
      reason: decision === 'approved' ? null : reason,
      notes: decision === 'approved' ? `${NOTE(l)} · approved: ${reason}`.slice(0, 2000) : null,
    });
    d.prepare("UPDATE scan_lessons SET decision = ?, decision_reason = ?, decided_by = ?, decided_at = datetime('now'), session_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(decision, reason, adminId, sessionId, l.id);
    db.audit({ entity: 'scan_lesson', entityId: l.id, action: decision, userId: adminId, reason, before: { state: l.state, decision: l.decision }, after: { decision, session_id: sessionId } });
    return sessionId;
  })();
}

module.exports = { rules, toMin, hhmm, nowIn, matchDay, parseLog, addScans, setPin, recompute, recomputeDate, board, lessonsFor, unmatched, decide, slotById, slotsFor, scannerInUse };
