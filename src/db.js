'use strict';
// Database connection and schema. SQLite keeps the whole school database in one file,
// which is easy to back up (copy the file) and needs no separate database server.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','student','parent','bursar')),
  language TEXT NOT NULL DEFAULT 'fr' CHECK (language IN ('en','fr')),
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS academic_years (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  year_id INTEGER NOT NULL REFERENCES academic_years(id),
  name TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

-- Days with no classes (holidays, exams, closures). Excluded from scheduled hours.
CREATE TABLE IF NOT EXISTS closures (
  id INTEGER PRIMARY KEY,
  year_id INTEGER NOT NULL REFERENCES academic_years(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_fr TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_fr TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  year_id INTEGER NOT NULL REFERENCES academic_years(id),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  level TEXT NOT NULL,           -- school-defined level, e.g. "Form 4", "Seconde", "1ère F3"
  name TEXT NOT NULL,            -- class name shown to users, e.g. "Form 4 A"
  UNIQUE (year_id, name)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  student_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  UNIQUE (student_id, class_id)
);

CREATE TABLE IF NOT EXISTS guardians (
  id INTEGER PRIMARY KEY,
  parent_user_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  relationship TEXT,
  UNIQUE (parent_user_id, student_id)
);

-- Which teacher teaches which subject to which class.
CREATE TABLE IF NOT EXISTS teaching_assignments (
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  UNIQUE (class_id, subject_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS timetable_slots (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES teaching_assignments(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- 1 = Monday
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  room TEXT
);

-- One row per class actually recorded (held, missed, cancelled, or a make-up lesson).
CREATE TABLE IF NOT EXISTS class_sessions (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE,                 -- prevents duplicates when a form is submitted twice
  assignment_id INTEGER NOT NULL REFERENCES teaching_assignments(id),
  slot_id INTEGER REFERENCES timetable_slots(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','missed','cancelled','makeup')),
  reason TEXT,
  makeup_status TEXT NOT NULL DEFAULT 'none' CHECK (makeup_status IN ('none','planned','completed','not_needed')),
  makeup_planned_date TEXT,
  makeup_for_session_id INTEGER REFERENCES class_sessions(id),
  notes TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_slot_date ON class_sessions(slot_id, date) WHERE slot_id IS NOT NULL;

-- Yearly plans (programmes). Each section, level and subject can have its own plan.
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  year_id INTEGER NOT NULL REFERENCES academic_years(id),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  level TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  title TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year_id, section_id, level, subject_id)
);

CREATE TABLE IF NOT EXISTS plan_chapters (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  term_id INTEGER REFERENCES terms(id),
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_lessons (
  id INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES plan_chapters(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  planned_date TEXT,              -- date by which the lesson should be reached
  planned_hours REAL
);

-- Append-only lesson progress entries. The latest entry for a lesson is its current status.
CREATE TABLE IF NOT EXISTS progress_entries (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE,
  assignment_id INTEGER NOT NULL REFERENCES teaching_assignments(id),
  lesson_id INTEGER NOT NULL REFERENCES plan_lessons(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','delayed')),
  notes TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
  note TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  UNIQUE (class_id, student_id, date)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('notice','exam','meeting','event','deadline')),
  title_en TEXT,
  body_en TEXT,
  title_fr TEXT,
  body_fr TEXT,
  audience TEXT NOT NULL,          -- comma list of roles: teacher,student,parent
  class_id INTEGER REFERENCES classes(id),   -- NULL = whole school
  publish_at TEXT NOT NULL,        -- not visible before this time
  expires_at TEXT,                 -- hidden after this time
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

-- Messages prepared for future SMS / WhatsApp delivery. Nothing here is sent until a real
-- integration exists; status stays 'not_sent' and we never display it as delivered.
CREATE TABLE IF NOT EXISTS message_outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('sms','whatsapp')),
  recipient_user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  source TEXT NOT NULL,            -- e.g. 'announcement:12' or 'absence:345'
  status TEXT NOT NULL DEFAULT 'not_sent' CHECK (status IN ('not_sent','sent','delivered','failed')),
  provider_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, recipient_user_id, source)
);

-- In-app notices (e.g. absence alerts to parents when the school enables them).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  data TEXT NOT NULL,              -- JSON, rendered with translations at display time
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  UNIQUE (user_id, source)
);

-- History of every change. Records are never silently overwritten.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_att_student ON attendance_records(student_id, date);
CREATE INDEX IF NOT EXISTS ix_sessions_assignment ON class_sessions(assignment_id, date);
CREATE INDEX IF NOT EXISTS ix_progress_assignment ON progress_entries(assignment_id, lesson_id);
`;

const DEFAULT_SETTINGS = {
  school_name: 'Lycée / High School',
  demo_mode: '0',
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
  db.exec(SCHEMA);
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

module.exports = { open, get, getSettings, setSetting, audit, currentYear, DEFAULT_SETTINGS };
