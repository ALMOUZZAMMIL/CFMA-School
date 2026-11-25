'use strict';
// Migration 2: optional email address on accounts (sign-in by email), unique when present.
module.exports = {
  version: 2,
  name: 'user_email',
  up(d) {
    const cols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('email')) d.exec('ALTER TABLE users ADD COLUMN email TEXT');
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL');
  },
};
