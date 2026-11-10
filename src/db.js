'use strict';
// Database connection and schema. SQLite keeps the whole school database in one file,
// which is easy to back up (copy the file) and needs no separate database server.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const migrations = require('./migrate');

// The schema lives in src/migrations/ (versioned, applied in order inside transactions).

const DEFAULT_SETTINGS = {
  school_name: 'Lycée / High School',
  demo_mode: '0',
  // Public page details. Empty values are shown as clearly marked placeholders.
  school_motto: '',
  school_address: '',
  school_phone: '',
  school_email: '',
  // Brand colours (derive them from the school logo). Text on brand_primary is white.
  // Defaults taken from the Collège Bilingue Maloum & Ayena flyer: royal blue, green and purple.
  brand_primary: '#2b3f98',
  brand_accent: '#1d7f43',
  brand_secondary: '#8e3c96',
  allow_account_requests: '1',
  timezone: 'Africa/Douala',
  currency: 'XAF',
  default_language: 'fr',
  // How parents hear about absences: 'none' or 'in_app'. SMS/WhatsApp are prepared only.
  parent_absence_alert: 'in_app',
  prepare_sms_for_absences: '0',
  absence_alert_statuses: 'absent',
  show_attendance_to_parents: '1',
  show_attendance_to_students: '1',
  show_progress_to_students: '1',
  repeat_absence_threshold: '3',
  repeat_absence_window_days: '30',
};

let db;

function open(file) {
  const dbFile = file || process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrations.run(db, { file: dbFile });
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function get() {
  if (!db) open();
  return db;
}

function getSettings() {
  const rows = get().prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function setSetting(key, value) {
  get().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function audit({ entity, entityId, action, userId, reason, before, after }) {
  get().prepare(`INSERT INTO audit_log (entity, entity_id, action, user_id, reason, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(entity, entityId ?? null, action, userId ?? null, reason || null,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

function currentYear() {
  return get().prepare('SELECT * FROM academic_years WHERE is_current = 1 ORDER BY start_date DESC LIMIT 1').get()
    || get().prepare('SELECT * FROM academic_years ORDER BY start_date DESC LIMIT 1').get();
}

function close() {
  if (db && db.open) db.close();
  db = undefined;
}

module.exports = { open, close, get, getSettings, setSetting, audit, currentYear, DEFAULT_SETTINGS };
