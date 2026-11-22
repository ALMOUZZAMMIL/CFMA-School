'use strict';
// Migration 5: fingerprint scanner attendance for teachers.
//
// Privacy by design: fingerprints never reach the portal. They stay inside the scanner, which
// only sends "staff number + time". The portal stores those scans, matches them against the
// timetable, and records the lesson in class_sessions like a hand-entered one.
//
// Scans are evidence, so the database itself refuses to change or delete them (triggers below).
// The only allowed change is filling in the teacher once, when an unknown staff number is
// linked to a teacher after the scan arrived.
module.exports = {
  version: 5,
  name: 'fingerprint_scanner',
  up(d) {
    d.exec(`
CREATE TABLE IF NOT EXISTS scan_devices (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,          -- the scanner's serial number (SN), sent with every request
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  allowed_ip TEXT,                      -- optional: only accept this device from this address
  last_seen_at TEXT,
  last_ip TEXT,
  clock_ahead_min INTEGER,              -- last time the device sent a scan dated in the future
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The number typed into the scanner for each teacher ("User ID" / "PIN" on ZKTeco devices).
ALTER TABLE users ADD COLUMN scanner_pin TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_scanner_pin ON users(scanner_pin) WHERE scanner_pin IS NOT NULL;

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  device_id INTEGER REFERENCES scan_devices(id),
  pin TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),  -- null while the staff number is not linked to a teacher
  scanned_at TEXT NOT NULL,              -- school local time, 'YYYY-MM-DD HH:MM:SS', as the device recorded it
  source TEXT NOT NULL CHECK (source IN ('device','file','test')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  received_by INTEGER REFERENCES users(id), -- who uploaded a file or a test scan
  UNIQUE (pin, scanned_at)
);
CREATE INDEX IF NOT EXISTS ix_scans_user_time ON scans(user_id, scanned_at);
CREATE INDEX IF NOT EXISTS ix_scans_time ON scans(scanned_at);

CREATE TRIGGER IF NOT EXISTS scans_read_only BEFORE UPDATE ON scans
WHEN OLD.user_id IS NOT NULL OR NEW.pin IS NOT OLD.pin OR NEW.scanned_at IS NOT OLD.scanned_at
  OR NEW.device_id IS NOT OLD.device_id OR NEW.source IS NOT OLD.source OR NEW.received_at IS NOT OLD.received_at
  OR NEW.received_by IS NOT OLD.received_by
BEGIN SELECT RAISE(ABORT, 'scan records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS scans_no_delete BEFORE DELETE ON scans
BEGIN SELECT RAISE(ABORT, 'scan records cannot be deleted'); END;

-- What the scans mean for each timetable slot on each day (recomputed as scans arrive).
CREATE TABLE IF NOT EXISTS scan_lessons (
  id INTEGER PRIMARY KEY,
  slot_id INTEGER NOT NULL REFERENCES timetable_slots(id),
  date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('in_class','done','unconfirmed','review','no_scan')),
  in_scan_id INTEGER REFERENCES scans(id),
  out_scan_id INTEGER REFERENCES scans(id),
  in_time TEXT,
  out_time TEXT,
  late_min INTEGER NOT NULL DEFAULT 0,
  early_min INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL DEFAULT 'auto' CHECK (decision IN ('auto','approved','rejected')),
  decision_reason TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  session_id INTEGER REFERENCES class_sessions(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (slot_id, date)
);
CREATE INDEX IF NOT EXISTS ix_scan_lessons_date ON scan_lessons(date, state);

-- A teacher's request to fix a lesson the scanner got wrong (forgot to scan, device down...).
CREATE TABLE IF NOT EXISTS scan_corrections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot_id INTEGER NOT NULL REFERENCES timetable_slots(id),
  date TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_scan_corrections_status ON scan_corrections(status);

-- Scans that match no lesson and that an admin has looked at and set aside.
CREATE TABLE IF NOT EXISTS scan_dismissals (
  scan_id INTEGER PRIMARY KEY REFERENCES scans(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Where a recorded lesson came from: typed by hand, the scanner, or an approved correction.
ALTER TABLE class_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','scanner','correction'));
`);
  },
};
