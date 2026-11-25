'use strict';
// Migration 5: the school calendar of activities (evaluations, deadlines, meetings, holidays...)
// Loaded by scripts/import-school-data.js; shown on the Calendar page.
module.exports = {
  version: 5,
  name: 'school_calendar',
  up(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS school_events (
      id INTEGER PRIMARY KEY,
      year_id INTEGER NOT NULL REFERENCES academic_years(id),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      title_fr TEXT NOT NULL,
      title_en TEXT NOT NULL,
      audience_fr TEXT,
      audience_en TEXT,
      venue TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_school_events_dates ON school_events(year_id, start_date);`);
  },
};
