'use strict';
// Helpers shared by the administration screens. Moved unchanged from the former src/routes/admin.js.
const crypto = require('crypto');
const db = require('../../db');
const auth = require('../../auth');

const ROLES = ['admin', 'teacher', 'student', 'parent', 'bursar'];

function back(res, url, type, key) { res.flash(type, key); res.redirect(url); }

// Readable temporary passwords (no confusable characters), shown once to the admin.
function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += chars[b % chars.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

function createUser({ username, full_name, role, language, phone, email }, adminId) {
  const pw = tempPassword();
  const info = db.get().prepare(`INSERT INTO users (username, password_hash, full_name, role, language, phone, email, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(username, auth.hashPassword(pw), full_name, role, language, phone || null, email || null);
  const id = Number(info.lastInsertRowid);
  db.audit({ entity: 'user', entityId: id, action: 'create', userId: adminId, after: { username, full_name, role } });
  return { id, password: pw };
}

function validUsername(u) { return /^[a-zA-Z0-9._-]{3,40}$/.test(u); }
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
function emailTaken(email, exceptId) {
  return !!(email && db.get().prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, exceptId || 0));
}


module.exports = { ROLES, back, tempPassword, createUser, validUsername, EMAIL, emailTaken };
