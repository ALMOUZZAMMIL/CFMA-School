'use strict';
// Administration: Access requests (public "Request an account" and "Forgot password").
// Moved unchanged from the former src/routes/admin.js. Admin role is required (see index.js).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const { Validator, int, str } = require('../../util');
const { back, createUser, validUsername, EMAIL, emailTaken } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
/* ---------- Access requests (public "Request an account" and "Forgot password") ---------- */

function suggestUsername(name) {
  const base = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30) || 'user';
  let u = base;
  for (let i = 2; db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(u); i++) u = `${base}${i}`;
  return u.length >= 3 ? u : `${u}.user`;
}

r.get('/admin/requests', (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'done'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.get().prepare(`SELECT ar.*, u.full_name AS handled_by_name FROM access_requests ar LEFT JOIN users u ON u.id = ar.handled_by
    WHERE ar.status = ? ORDER BY ar.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 300`).all(status);
  const counts = Object.fromEntries(db.get().prepare('SELECT status, COUNT(*) n FROM access_requests GROUP BY status').all().map((x) => [x.status, x.n]));
  res.render('admin/requests', { title: req.t('requests.title'), rows, status, counts });
});

function loadRequest(req) {
  return db.get().prepare('SELECT ar.*, u.full_name AS handled_by_name FROM access_requests ar LEFT JOIN users u ON u.id = ar.handled_by WHERE ar.id = ?').get(int(req.params.id));
}

function requestPage(req, res, ar, { errors = [], values = {}, status = 200 } = {}) {
  const d = db.get();
  const year = res.locals.year;
  let matches = [];
  if (ar.kind === 'password_reset') {
    const digits = String(ar.identifier || '').replace(/\D/g, '');
    const phoneDigits = String(ar.phone || '').replace(/\D/g, '');
    matches = d.prepare(`SELECT id, username, full_name, role, phone, email, active FROM users WHERE username = @id COLLATE NOCASE OR email = @id COLLATE NOCASE
      OR (@digits != '' AND length(@digits) >= 6 AND replace(replace(replace(replace(phone, ' ', ''), '+', ''), '-', ''), '.', '') LIKE '%' || @digits)
      OR (@pd != '' AND length(@pd) >= 6 AND replace(replace(replace(replace(phone, ' ', ''), '+', ''), '-', ''), '.', '') LIKE '%' || @pd)
      LIMIT 10`).all({ id: ar.identifier || '', digits, pd: phoneDigits });
  }
  const students = year ? d.prepare(`SELECT st.id, st.full_name, st.student_number, st.user_id, c.name AS class_name FROM students st
    JOIN enrollments e ON e.student_id = st.id JOIN classes c ON c.id = e.class_id WHERE c.year_id = ? ORDER BY c.name, st.full_name`).all(year.id) : [];
  res.status(status).render('admin/request', {
    title: req.t('requests.title'), ar, matches, students, errors,
    values: { role: ar.role_requested, username: ar.kind === 'account' ? suggestUsername(ar.full_name) : '', full_name: ar.full_name, phone: ar.phone, email: ar.email, language: ar.language, ...values },
  });
}

r.get('/admin/requests/:id', (req, res) => {
  const ar = loadRequest(req);
  if (!ar) return auth.notFound(req, res);
  requestPage(req, res, ar);
});

// Approving creates the account with a temporary password. Children are linked only by the
// administrator, after checking the person's identity: never from what the requester typed.
r.post('/admin/requests/:id/approve', (req, res) => {
  const ar = loadRequest(req);
  if (!ar || ar.kind !== 'account' || ar.status !== 'pending') return auth.notFound(req, res);
  const values = {
    role: str(req.body.role, 10), username: str(req.body.username, 40).toLowerCase(), full_name: str(req.body.full_name, 120),
    phone: str(req.body.phone, 30), email: str(req.body.email, 200).toLowerCase(), language: req.body.language === 'en' ? 'en' : 'fr',
    student_id: int(req.body.student_id), relationship: str(req.body.relationship, 40),
  };
  const v = new Validator().required(values.full_name, 'full_name').required(values.username, 'username')
    .required(values.role, 'role').oneOf(values.role, ['teacher', 'parent', 'student'], 'role');
  if (values.username) v.check(validUsername(values.username), 'username', 'admin.usernameFormat');
  if (values.username && db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) v.errors.push({ field: 'username', key: 'admin.usernameTaken' });
  if (values.phone) v.check(/^[+\d][\d\s.-]{5,20}$/.test(values.phone), 'phone', 'validation.phone');
  if (values.email) v.check(EMAIL.test(values.email), 'email', 'validation.email');
  if (emailTaken(values.email)) v.errors.push({ field: 'email', key: 'admin.emailTaken' });
  let student = null;
  if (values.student_id) student = db.get().prepare('SELECT * FROM students WHERE id = ?').get(values.student_id);
  if (values.role === 'student') {
    v.check(!!student, 'student_id', 'requests.pickStudent');
    if (student) v.check(!student.user_id, 'student_id', 'requests.studentHasLogin');
  }
  if (values.student_id && !student) v.errors.push({ field: 'student_id', key: 'validation.choice' });
  if (!v.ok) return requestPage(req, res, ar, { errors: v.errors, values, status: 400 });
  let created;
  db.get().transaction(() => {
    created = createUser(values, req.user.id);
    if (values.role === 'student') db.get().prepare('UPDATE students SET user_id = ? WHERE id = ?').run(created.id, student.id);
    if (values.role === 'parent' && student) {
      db.get().prepare('INSERT OR IGNORE INTO guardians (parent_user_id, student_id, relationship) VALUES (?, ?, ?)').run(created.id, student.id, values.relationship || null);
      db.audit({ entity: 'guardian', entityId: student.id, action: 'link', userId: req.user.id, after: { parent_user_id: created.id, relationship: values.relationship } });
    }
    db.get().prepare("UPDATE access_requests SET status = 'approved', handled_by = ?, handled_at = datetime('now'), created_user_id = ? WHERE id = ?").run(req.user.id, created.id, ar.id);
    db.audit({ entity: 'access_request', entityId: ar.id, action: 'approve', userId: req.user.id, after: { user_id: created.id, role: values.role } });
  })();
  res.render('admin/student-created', {
    title: req.t('requests.title'),
    created: { id: values.role === 'parent' && !student ? null : (student && student.id), userId: created.id, username: values.username, password: created.password, full_name: values.full_name, parent: values.role === 'parent' },
  });
});

r.post('/admin/requests/:id/reject', (req, res) => {
  const ar = loadRequest(req);
  if (!ar || ar.status !== 'pending') return auth.notFound(req, res);
  const note = str(req.body.admin_note, 500);
  db.get().prepare("UPDATE access_requests SET status = 'rejected', admin_note = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?").run(note || null, req.user.id, ar.id);
  db.audit({ entity: 'access_request', entityId: ar.id, action: 'reject', userId: req.user.id, reason: note });
  back(res, '/admin/requests', 'ok', 'requests.rejected');
});

r.post('/admin/requests/:id/done', (req, res) => {
  const ar = loadRequest(req);
  if (!ar || ar.status !== 'pending') return auth.notFound(req, res);
  const note = str(req.body.admin_note, 500);
  db.get().prepare("UPDATE access_requests SET status = 'done', admin_note = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?").run(note || null, req.user.id, ar.id);
  db.audit({ entity: 'access_request', entityId: ar.id, action: 'done', userId: req.user.id, reason: note });
  back(res, '/admin/requests', 'ok', 'requests.markedDone');
});

module.exports = r;
