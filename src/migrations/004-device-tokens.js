'use strict';
// Migration 4: "known device" tokens for sign-in protection. After a successful sign-in the
// browser gets a random token (only its SHA-256 hash is stored). A device token never signs
// anyone in: the password is always required. It only lets the account's own known devices
// keep trying when a shared school address or the account is being flooded with wrong guesses.
module.exports = {
  version: 4,
  name: 'device_tokens',
  up(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS device_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_device_tokens_user ON device_tokens(user_id);`);
  },
};
