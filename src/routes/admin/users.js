'use strict';
// Administration: User accounts.
// Moved unchanged from the former src/routes/admin.js. Admin role is required (see index.js).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const guard = require('../../login-guard');
const { Validator, int, str } = require('../../util');
const { ROLES, back, tempPassword, createUser, validUsername, EMAIL, emailTaken } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
/* ---------- Users ---------- */

r.get('/admin/users', (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : null;
  const q = str(req.query.q, 60);
  const rows = db.get().prepare(`SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at FROM users
    WHERE (@role IS NULL OR role = @role) AND (@q = '' OR full_name LIKE @like OR username LIKE @like) ORDER BY role, full_name LIMIT 500`)
    .all({ role, q, like: `%${q}%` });
  res.render('admin/users', { title: req.t('admin.users'), rows, role, q, roles: ROLES, created: null, errors: [], values: {} });
});

r.post('/admin/users', (req, res) => {
  const values = { username: str(req.body.username, 40).toLowerCase(), full_name: str(req.body.full_name, 120), role: str(req.body.role, 10), language: req.body.language === 'en' ? 'en' : 'fr', phone: str(req.body.phone, 30), email: str(req.body.email, 200).toLowerCase() };
  const v = new Validator().required(values.username, 'username').required(values.full_name, 'full_name').oneOf(values.role, ROLES, 'role').required(values.role, 'role');
  if (values.username) v.check(validUsername(values.username), 'username', 'admin.usernameFormat');
  if (values.phone) v.check(/^[+\d][\d\s-]{5,20}$/.test(values.phone), 'phone', 'validation.phone');
  if (values.email) v.check(EMAIL.test(values.email), 'email', 'validation.email');
  if (emailTaken(values.email)) v.errors.push({ field: 'email', key: 'admin.emailTaken' });
  if (v.ok && db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) v.errors.push({ field: 'username', key: 'admin.usernameTaken' });
  if (values.role === 'student') v.errors.push({ field: 'role', key: 'admin.createStudentsFromStudentsPage' });
  const rows = db.get().prepare('SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at FROM users ORDER BY role, full_name LIMIT 500').all();
  if (!v.ok) return res.status(400).render('admin/users', { title: req.t('admin.users'), rows, role: null, q: '', roles: ROLES, created: null, errors: v.errors, values });
  const { id, password } = createUser(values, req.user.id);
  const rows2 = db.get().prepare('SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at FROM users ORDER BY role, full_name LIMIT 500').all();
  res.render('admin/users', { title: req.t('admin.users'), rows: rows2, role: null, q: '', roles: ROLES, created: { id, username: values.username, password }, errors: [], values: {} });
});

r.get('/admin/users/:id', (req, res) => {
  const u = db.get().prepare('SELECT id, username, full_name, role, language, phone, email, active, must_change_password, last_login_at, created_at FROM users WHERE id = ?').get(int(req.params.id));
  if (!u) return auth.notFound(req, res);
  const children = u.role === 'parent' ? db.get().prepare('SELECT st.*, g.relationship, g.id AS link_id FROM guardians g JOIN students st ON st.id = g.student_id WHERE g.parent_user_id = ?').all(u.id) : [];
  res.render('admin/user', { title: u.full_name, u, children, reset: null });
});

r.post('/admin/users/:id', (req, res) => {
  const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(int(req.params.id));
  if (!u) return auth.notFound(req, res);
  const v = { full_name: str(req.body.full_name, 120), phone: str(req.body.phone, 30) || null, email: str(req.body.email, 200).toLowerCase() || null, language: req.body.language === 'en' ? 'en' : 'fr', active: req.body.active === '1' ? 1 : 0 };
  if (!v.full_name || (v.phone && !/^[+\d][\d\s-]{5,20}$/.test(v.phone)) || (v.email && !EMAIL.test(v.email))) return back(res, `/admin/users/${u.id}`, 'error', 'validation.checkFields');
  if (emailTaken(v.email, u.id)) return back(res, `/admin/users/${u.id}`, 'error', 'admin.emailTaken');
  if (u.id === req.user.id && !v.active) return back(res, `/admin/users/${u.id}`, 'error', 'admin.cannotDeactivateSelf');
  db.get().transaction(() => {
    db.get().prepare('UPDATE users SET full_name = @full_name, phone = @phone, email = @email, language = @language, active = @active WHERE id = @id').run({ ...v, id: u.id });
    if (!v.active) {
      db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      guard.revokeDevices(u.id);
    }
    db.audit({ entity: 'user', entityId: u.id, action: 'update', userId: req.user.id, before: { full_name: u.full_name, phone: u.phone, email: u.email, active: u.active }, after: v });
  })();
  back(res, `/admin/users/${u.id}`, 'ok', 'common.saved');
});

r.post('/admin/users/:id/reset-password', (req, res) => {
  const u = db.get().prepare('SELECT id, username, full_name, role, language, phone, email, active, must_change_password, last_login_at, created_at FROM users WHERE id = ?').get(int(req.params.id));
  if (!u) return auth.notFound(req, res);
  const pw = tempPassword();
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(pw), u.id);
  db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  guard.revokeDevices(u.id);
  db.audit({ entity: 'user', entityId: u.id, action: 'password_reset', userId: req.user.id });
  const children = u.role === 'parent' ? db.get().prepare('SELECT st.*, g.relationship, g.id AS link_id FROM guardians g JOIN students st ON st.id = g.student_id WHERE g.parent_user_id = ?').all(u.id) : [];
  res.render('admin/user', { title: u.full_name, u, children, reset: pw });
});

module.exports = r;
