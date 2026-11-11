'use strict';
// Creates the first administrator account on a real installation.
// Usage: npm run create-admin -- <username> "<Full name>"
// A temporary password is printed once; it must be changed at first sign-in.
require('../src/env');
process.umask(0o077); // database and backup files private to this account
const crypto = require('crypto');
const db = require('../src/db');
const auth = require('../src/auth');

const [username, fullName] = process.argv.slice(2);
if (!username || !fullName || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
  console.error('Usage: npm run create-admin -- <username> "<Full name>"\nUsername: 3-40 letters, numbers, dots, dashes or underscores.');
  process.exit(1);
}
db.open();
if (db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
  console.error(`The username "${username}" already exists.`);
  process.exit(1);
}
const password = crypto.randomBytes(9).toString('base64url');
db.get().prepare("INSERT INTO users (username, password_hash, full_name, role, language, must_change_password) VALUES (?, ?, ?, 'admin', 'fr', 1)")
  .run(username.toLowerCase(), auth.hashPassword(password), fullName);
console.log(`Administrator created.\n  Username: ${username.toLowerCase()}\n  Temporary password: ${password}\nSign in and choose a new password. This password is not shown again.`);
