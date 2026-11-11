'use strict';
// Migration 3: last activity time on login sessions, for the idle timeout.
module.exports = {
  version: 3,
  name: 'session_last_seen',
  up(d) {
    const cols = d.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    if (!cols.includes('last_seen_at')) d.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
    d.exec("UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL");
  },
};
