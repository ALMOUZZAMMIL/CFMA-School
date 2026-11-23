'use strict';
// Migration 6: progression sheets (yearly plans) are locked once submitted.
// A teacher can draft the sheet for a subject they teach; after "Submit and lock" nobody but the
// administration can open it again, through a change request that the administration approves
// for a limited time. Every change is kept in the history (audit_log, entity 'plan').
// Existing plans (imported official programmes, demo plans) start locked.
module.exports = {
  version: 6,
  name: 'plan_locking',
  up(d) {
    d.exec(`ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('draft','locked'));
    ALTER TABLE plans ADD COLUMN submitted_by INTEGER REFERENCES users(id);
    ALTER TABLE plans ADD COLUMN submitted_at TEXT;
    -- An approved change request opens the sheet to one teacher until this time (UTC, 'YYYY-MM-DD HH:MM:SS').
    ALTER TABLE plans ADD COLUMN edit_until TEXT;
    ALTER TABLE plans ADD COLUMN edit_user_id INTEGER REFERENCES users(id);
    CREATE TABLE IF NOT EXISTS plan_change_requests (
      id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','closed')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      window_hours INTEGER,
      closed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_plan_requests ON plan_change_requests(plan_id, status);`);
    // New settings get their defaults from DEFAULT_SETTINGS in src/db.js.
  },
};
