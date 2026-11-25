'use strict';
// Migration 7: upload windows, module durations and exam periods.
//  - terms.plan_window_start/end: the dates during which teachers may upload or complete the
//    progression sheet for that term (set by the administration each term).
//  - plan_term_submissions: a teacher locks the part of the sheet for one term at the end of
//    that term's window.
//  - plan_lessons.duration_days / duration_max_days / start_date: "finish this in 2 days",
//    "1 week", "between 1 and 2 weeks" (in school days). The dates are worked out from them,
//    skipping weekends, holidays and exam periods.
//  - school_events.pauses_lessons: an exam period during which lessons stop (default) or go on.
//    school_events.source: 'import' (school-data calendar) or 'admin' (added in the app).
module.exports = {
  version: 7,
  name: 'plan_schedule',
  up(d) {
    d.exec(`ALTER TABLE terms ADD COLUMN plan_window_start TEXT;
    ALTER TABLE terms ADD COLUMN plan_window_end TEXT;
    CREATE TABLE IF NOT EXISTS plan_term_submissions (
      plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      term_id INTEGER NOT NULL REFERENCES terms(id),
      submitted_by INTEGER REFERENCES users(id),
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plan_id, term_id)
    );
    ALTER TABLE plan_lessons ADD COLUMN duration_days REAL;
    ALTER TABLE plan_lessons ADD COLUMN duration_max_days REAL;
    ALTER TABLE plan_lessons ADD COLUMN start_date TEXT;
    ALTER TABLE school_events ADD COLUMN pauses_lessons INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE school_events ADD COLUMN source TEXT NOT NULL DEFAULT 'import';`);
  },
};
