'use strict';
// Administrator configuration: school structure, users, students, teaching assignments,
// timetables and settings. Every route here requires the admin role on the server.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { Validator, int, str, isDate, isTime, minutesBetween } = require('../util');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));

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

r.get('/admin', (req, res) => res.render('admin/index', { title: req.t('admin.title') }));

/* ---------- School structure: years, terms, closures, sections, subjects, classes ---------- */

r.get('/admin/structure', (req, res) => {
  const d = db.get();
  const years = d.prepare('SELECT * FROM academic_years ORDER BY start_date DESC').all();
  const yearId = int(req.query.year) || (res.locals.year && res.locals.year.id);
  res.render('admin/structure', {
    title: req.t('admin.structure'), years, yearId,
    terms: d.prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(yearId),
    closures: d.prepare('SELECT * FROM closures WHERE year_id = ? ORDER BY start_date').all(yearId),
    sections: d.prepare('SELECT * FROM sections ORDER BY id').all(),
    subjects: d.prepare('SELECT * FROM subjects ORDER BY active DESC, name_en').all(),
    classes: d.prepare(`SELECT c.*, se.name_en AS section_en, se.name_fr AS section_fr, (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS students
      FROM classes c JOIN sections se ON se.id = c.section_id WHERE c.year_id = ? ORDER BY se.id, c.level, c.name`).all(yearId),
  });
});

r.post('/admin/years', (req, res) => {
  const name = str(req.body.name, 40);
  const start = str(req.body.start_date, 10);
  const end = str(req.body.end_date, 10);
  if (!name || !isDate(start) || !isDate(end) || end <= start) return back(res, '/admin/structure', 'error', 'validation.checkFields');
  if (db.get().prepare('SELECT 1 FROM academic_years WHERE name = ?').get(name)) return back(res, '/admin/structure', 'error', 'admin.duplicate');
  const info = db.get().prepare('INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES (?, ?, ?, (SELECT COUNT(*) = 0 FROM academic_years))').run(name, start, end);
  db.audit({ entity: 'academic_year', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: { name, start, end } });
  back(res, `/admin/structure?year=${info.lastInsertRowid}`, 'ok', 'common.saved');
});

r.post('/admin/years/:id/current', (req, res) => {
  const y = db.get().prepare('SELECT * FROM academic_years WHERE id = ?').get(int(req.params.id));
  if (!y) return auth.notFound(req, res);
  db.get().transaction(() => {
    db.get().prepare('UPDATE academic_years SET is_current = (id = ?)').run(y.id);
    db.audit({ entity: 'academic_year', entityId: y.id, action: 'set_current', userId: req.user.id });
  })();
  back(res, `/admin/structure?year=${y.id}`, 'ok', 'common.saved');
});

r.post('/admin/terms', (req, res) => {
  const yearId = int(req.body.year_id);
  const y = db.get().prepare('SELECT * FROM academic_years WHERE id = ?').get(yearId);
  const name = str(req.body.name, 40);
  const start = str(req.body.start_date, 10);
  const end = str(req.body.end_date, 10);
  const url = `/admin/structure?year=${yearId}`;
  if (!y || !name || !isDate(start) || !isDate(end) || end < start) return back(res, url, 'error', 'validation.checkFields');
  if (start < y.start_date || end > y.end_date) return back(res, url, 'error', 'admin.termOutsideYear');
  const ordinal = db.get().prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 n FROM terms WHERE year_id = ?').get(yearId).n;
  const info = db.get().prepare('INSERT INTO terms (year_id, name, ordinal, start_date, end_date) VALUES (?, ?, ?, ?, ?)').run(yearId, name, ordinal, start, end);
  db.audit({ entity: 'term', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: { name, start, end } });
  back(res, url, 'ok', 'common.saved');
});

r.post('/admin/terms/:id', (req, res) => {
  const tm = db.get().prepare('SELECT * FROM terms WHERE id = ?').get(int(req.params.id));
  if (!tm) return auth.notFound(req, res);
  const y = db.get().prepare('SELECT * FROM academic_years WHERE id = ?').get(tm.year_id);
  const name = str(req.body.name, 40);
  const start = str(req.body.start_date, 10);
  const end = str(req.body.end_date, 10);
  const url = `/admin/structure?year=${tm.year_id}`;
  if (!name || !isDate(start) || !isDate(end) || end < start) return back(res, url, 'error', 'validation.checkFields');
  if (start < y.start_date || end > y.end_date) return back(res, url, 'error', 'admin.termOutsideYear');
  db.get().prepare('UPDATE terms SET name = ?, start_date = ?, end_date = ? WHERE id = ?').run(name, start, end, tm.id);
  db.audit({ entity: 'term', entityId: tm.id, action: 'update', userId: req.user.id, before: tm, after: { name, start, end } });
  back(res, url, 'ok', 'common.saved');
});

r.post('/admin/closures', (req, res) => {
  const yearId = int(req.body.year_id);
  const start = str(req.body.start_date, 10);
  const end = str(req.body.end_date, 10) || start;
  const reason = str(req.body.reason, 200);
  const url = `/admin/structure?year=${yearId}`;
  if (!yearId || !isDate(start) || !isDate(end) || end < start || !reason) return back(res, url, 'error', 'validation.checkFields');
  const info = db.get().prepare('INSERT INTO closures (year_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)').run(yearId, start, end, reason);
  db.audit({ entity: 'closure', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: { start, end, reason } });
  back(res, url, 'ok', 'common.saved');
});

r.post('/admin/closures/:id/delete', (req, res) => {
  const c = db.get().prepare('SELECT * FROM closures WHERE id = ?').get(int(req.params.id));
  if (!c) return auth.notFound(req, res);
  db.get().prepare('DELETE FROM closures WHERE id = ?').run(c.id);
  db.audit({ entity: 'closure', entityId: c.id, action: 'delete', userId: req.user.id, before: c });
  back(res, `/admin/structure?year=${c.year_id}`, 'ok', 'common.deleted');
});

r.post('/admin/sections', (req, res) => {
  const v = { code: str(req.body.code, 20).toUpperCase(), name_en: str(req.body.name_en, 80), name_fr: str(req.body.name_fr, 80) };
  if (!v.code || !v.name_en || !v.name_fr) return back(res, '/admin/structure', 'error', 'validation.checkFields');
  if (db.get().prepare('SELECT 1 FROM sections WHERE code = ?').get(v.code)) return back(res, '/admin/structure', 'error', 'admin.duplicate');
  const info = db.get().prepare('INSERT INTO sections (code, name_en, name_fr) VALUES (@code, @name_en, @name_fr)').run(v);
  db.audit({ entity: 'section', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, '/admin/structure', 'ok', 'common.saved');
});

r.post('/admin/subjects', (req, res) => {
  const v = { code: str(req.body.code, 20).toUpperCase(), name_en: str(req.body.name_en, 80), name_fr: str(req.body.name_fr, 80) };
  if (!v.code || !v.name_en || !v.name_fr) return back(res, '/admin/structure#subjects', 'error', 'validation.checkFields');
  if (db.get().prepare('SELECT 1 FROM subjects WHERE code = ?').get(v.code)) return back(res, '/admin/structure#subjects', 'error', 'admin.duplicate');
  const info = db.get().prepare('INSERT INTO subjects (code, name_en, name_fr) VALUES (@code, @name_en, @name_fr)').run(v);
  db.audit({ entity: 'subject', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, '/admin/structure#subjects', 'ok', 'common.saved');
});

r.post('/admin/subjects/:id', (req, res) => {
  const s = db.get().prepare('SELECT * FROM subjects WHERE id = ?').get(int(req.params.id));
  if (!s) return auth.notFound(req, res);
  const v = { name_en: str(req.body.name_en, 80), name_fr: str(req.body.name_fr, 80), active: req.body.active === '1' ? 1 : 0, id: s.id };
  if (!v.name_en || !v.name_fr) return back(res, '/admin/structure#subjects', 'error', 'validation.checkFields');
  db.get().prepare('UPDATE subjects SET name_en = @name_en, name_fr = @name_fr, active = @active WHERE id = @id').run(v);
  db.audit({ entity: 'subject', entityId: s.id, action: 'update', userId: req.user.id, before: s, after: v });
  back(res, '/admin/structure#subjects', 'ok', 'common.saved');
});

r.post('/admin/classes', (req, res) => {
  const v = { year_id: int(req.body.year_id), section_id: int(req.body.section_id), level: str(req.body.level, 60), name: str(req.body.name, 60) };
  const url = `/admin/structure?year=${v.year_id}#classes`;
  if (!v.year_id || !v.section_id || !v.level || !v.name) return back(res, url, 'error', 'validation.checkFields');
  if (db.get().prepare('SELECT 1 FROM classes WHERE year_id = ? AND name = ?').get(v.year_id, v.name)) return back(res, url, 'error', 'admin.duplicate');
  const info = db.get().prepare('INSERT INTO classes (year_id, section_id, level, name) VALUES (@year_id, @section_id, @level, @name)').run(v);
  db.audit({ entity: 'class', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, url, 'ok', 'common.saved');
});

/* ---------- Users ---------- */

r.get('/admin/users', (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : null;
  const q = str(req.query.q, 60);
  const rows = db.get().prepare(`SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at FROM users
    WHERE (@role IS NULL OR role = @role) AND (@q = '' OR full_name LIKE @like OR username LIKE @like) ORDER BY role, full_name LIMIT 500`)
    .all({ role, q, like: `%${q}%` });
  res.render('admin/users', { title: req.t('admin.users'), rows, role, q, roles: ROLES, created: null, errors: [], values: {} });
});

function createUser({ username, full_name, role, language, phone }, adminId) {
  const pw = tempPassword();
  const info = db.get().prepare(`INSERT INTO users (username, password_hash, full_name, role, language, phone, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(username, auth.hashPassword(pw), full_name, role, language, phone || null);
  const id = Number(info.lastInsertRowid);
  db.audit({ entity: 'user', entityId: id, action: 'create', userId: adminId, after: { username, full_name, role } });
  return { id, password: pw };
}

function validUsername(u) { return /^[a-zA-Z0-9._-]{3,40}$/.test(u); }

r.post('/admin/users', (req, res) => {
  const values = { username: str(req.body.username, 40).toLowerCase(), full_name: str(req.body.full_name, 120), role: str(req.body.role, 10), language: req.body.language === 'en' ? 'en' : 'fr', phone: str(req.body.phone, 30) };
  const v = new Validator().required(values.username, 'username').required(values.full_name, 'full_name').oneOf(values.role, ROLES, 'role').required(values.role, 'role');
  if (values.username) v.check(validUsername(values.username), 'username', 'admin.usernameFormat');
  if (values.phone) v.check(/^[+\d][\d\s-]{5,20}$/.test(values.phone), 'phone', 'validation.phone');
  if (v.ok && db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) v.errors.push({ field: 'username', key: 'admin.usernameTaken' });
  if (values.role === 'student') v.errors.push({ field: 'role', key: 'admin.createStudentsFromStudentsPage' });
  const rows = db.get().prepare('SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at FROM users ORDER BY role, full_name LIMIT 500').all();
  if (!v.ok) return res.status(400).render('admin/users', { title: req.t('admin.users'), rows, role: null, q: '', roles: ROLES, created: null, errors: v.errors, values });
  const { id, password } = createUser(values, req.user.id);
  const rows2 = db.get().prepare('SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at FROM users ORDER BY role, full_name LIMIT 500').all();
  res.render('admin/users', { title: req.t('admin.users'), rows: rows2, role: null, q: '', roles: ROLES, created: { id, username: values.username, password }, errors: [], values: {} });
});

r.get('/admin/users/:id', (req, res) => {
  const u = db.get().prepare('SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at, created_at FROM users WHERE id = ?').get(int(req.params.id));
  if (!u) return auth.notFound(req, res);
  const children = u.role === 'parent' ? db.get().prepare('SELECT st.*, g.relationship, g.id AS link_id FROM guardians g JOIN students st ON st.id = g.student_id WHERE g.parent_user_id = ?').all(u.id) : [];
  res.render('admin/user', { title: u.full_name, u, children, reset: null });
});

r.post('/admin/users/:id', (req, res) => {
  const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(int(req.params.id));
  if (!u) return auth.notFound(req, res);
  const v = { full_name: str(req.body.full_name, 120), phone: str(req.body.phone, 30) || null, language: req.body.language === 'en' ? 'en' : 'fr', active: req.body.active === '1' ? 1 : 0 };
  if (!v.full_name || (v.phone && !/^[+\d][\d\s-]{5,20}$/.test(v.phone))) return back(res, `/admin/users/${u.id}`, 'error', 'validation.checkFields');
  if (u.id === req.user.id && !v.active) return back(res, `/admin/users/${u.id}`, 'error', 'admin.cannotDeactivateSelf');
  db.get().transaction(() => {
    db.get().prepare('UPDATE users SET full_name = @full_name, phone = @phone, language = @language, active = @active WHERE id = @id').run({ ...v, id: u.id });
    if (!v.active) db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.audit({ entity: 'user', entityId: u.id, action: 'update', userId: req.user.id, before: { full_name: u.full_name, phone: u.phone, active: u.active }, after: v });
  })();
  back(res, `/admin/users/${u.id}`, 'ok', 'common.saved');
});

r.post('/admin/users/:id/reset-password', (req, res) => {
  const u = db.get().prepare('SELECT id, username, full_name, role, language, phone, active, must_change_password, last_login_at, created_at FROM users WHERE id = ?').get(int(req.params.id));
  if (!u) return auth.notFound(req, res);
  const pw = tempPassword();
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(pw), u.id);
  db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.audit({ entity: 'user', entityId: u.id, action: 'password_reset', userId: req.user.id });
  const children = u.role === 'parent' ? db.get().prepare('SELECT st.*, g.relationship, g.id AS link_id FROM guardians g JOIN students st ON st.id = g.student_id WHERE g.parent_user_id = ?').all(u.id) : [];
  res.render('admin/user', { title: u.full_name, u, children, reset: pw });
});

/* ---------- Students, enrolment and guardians ---------- */

r.get('/admin/students', (req, res) => {
  const year = res.locals.year;
  if (!year) return back(res, '/admin/structure', 'info', 'admin.createYearFirst');
  const classId = int(req.query.class);
  const q = str(req.query.q, 60);
  const classes = db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  const rows = db.get().prepare(`SELECT st.*, c.name AS class_name, u.username,
      (SELECT COUNT(*) FROM guardians g WHERE g.student_id = st.id) AS guardians
    FROM students st LEFT JOIN enrollments e ON e.student_id = st.id AND e.class_id IN (SELECT id FROM classes WHERE year_id = @year)
    LEFT JOIN classes c ON c.id = e.class_id LEFT JOIN users u ON u.id = st.user_id
    WHERE (@cls IS NULL OR c.id = @cls) AND (@q = '' OR st.full_name LIKE @like OR st.student_number LIKE @like)
    ORDER BY c.name, st.full_name LIMIT 1000`).all({ year: year.id, cls: classId, q, like: `%${q}%` });
  res.render('admin/students', { title: req.t('admin.students'), rows, classes, classId, q, created: null, errors: [], values: {} });
});

r.post('/admin/students', (req, res) => {
  const year = res.locals.year;
  const values = { student_number: str(req.body.student_number, 30), full_name: str(req.body.full_name, 120), class_id: int(req.body.class_id), create_login: req.body.create_login === '1', is_demo: req.body.is_demo === '1' ? 1 : 0 };
  const v = new Validator().required(values.student_number, 'student_number').required(values.full_name, 'full_name').required(values.class_id, 'class_id');
  if (values.class_id) v.check(!!db.get().prepare('SELECT 1 FROM classes WHERE id = ? AND year_id = ?').get(values.class_id, year.id), 'class_id', 'validation.choice');
  if (values.student_number && db.get().prepare('SELECT 1 FROM students WHERE student_number = ?').get(values.student_number)) v.errors.push({ field: 'student_number', key: 'admin.duplicate' });
  const username = `s${values.student_number}`.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (values.create_login && db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(username)) v.errors.push({ field: 'student_number', key: 'admin.usernameTaken' });
  const classes = db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  if (!v.ok) return res.status(400).render('admin/students', { title: req.t('admin.students'), rows: [], classes, classId: null, q: '', created: null, errors: v.errors, values });
  let created = null;
  db.get().transaction(() => {
    let userId = null;
    if (values.create_login) {
      const u = createUser({ username, full_name: values.full_name, role: 'student', language: 'fr' }, req.user.id);
      userId = u.id;
      created = { username, password: u.password };
    }
    const sid = Number(db.get().prepare('INSERT INTO students (user_id, student_number, full_name, is_demo) VALUES (?, ?, ?, ?)').run(userId, values.student_number, values.full_name, values.is_demo).lastInsertRowid);
    db.get().prepare('INSERT INTO enrollments (student_id, class_id) VALUES (?, ?)').run(sid, values.class_id);
    db.audit({ entity: 'student', entityId: sid, action: 'create', userId: req.user.id, after: { ...values, create_login: undefined } });
    created = { ...(created || {}), id: sid, full_name: values.full_name };
  })();
  if (!created.password) return back(res, `/admin/students/${created.id}`, 'ok', 'common.saved');
  res.render('admin/student-created', { title: req.t('admin.students'), created });
});

r.get('/admin/students/:id', (req, res) => {
  const year = res.locals.year;
  const st = db.get().prepare('SELECT st.*, u.username FROM students st LEFT JOIN users u ON u.id = st.user_id WHERE st.id = ?').get(int(req.params.id));
  if (!st) return auth.notFound(req, res);
  const enrollments = db.get().prepare('SELECT e.*, c.name, y.name AS year_name FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN academic_years y ON y.id = c.year_id WHERE e.student_id = ? ORDER BY y.start_date DESC').all(st.id);
  const guardians = db.get().prepare('SELECT g.*, u.full_name, u.username, u.phone FROM guardians g JOIN users u ON u.id = g.parent_user_id WHERE g.student_id = ?').all(st.id);
  const parents = db.get().prepare("SELECT id, full_name, username FROM users WHERE role = 'parent' AND active = 1 ORDER BY full_name").all();
  const classes = db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  res.render('admin/student', { title: st.full_name, st, enrollments, guardians, parents, classes, created: null });
});

r.post('/admin/students/:id', (req, res) => {
  const st = db.get().prepare('SELECT * FROM students WHERE id = ?').get(int(req.params.id));
  if (!st) return auth.notFound(req, res);
  const full_name = str(req.body.full_name, 120);
  if (!full_name) return back(res, `/admin/students/${st.id}`, 'error', 'validation.checkFields');
  db.get().prepare('UPDATE students SET full_name = ? WHERE id = ?').run(full_name, st.id);
  if (st.user_id) db.get().prepare('UPDATE users SET full_name = ? WHERE id = ?').run(full_name, st.user_id);
  db.audit({ entity: 'student', entityId: st.id, action: 'update', userId: req.user.id, before: { full_name: st.full_name }, after: { full_name } });
  back(res, `/admin/students/${st.id}`, 'ok', 'common.saved');
});

// Move a student to another class in the current year (keeps their past attendance).
r.post('/admin/students/:id/class', (req, res) => {
  const year = res.locals.year;
  const st = db.get().prepare('SELECT * FROM students WHERE id = ?').get(int(req.params.id));
  const classId = int(req.body.class_id);
  if (!st || !db.get().prepare('SELECT 1 FROM classes WHERE id = ? AND year_id = ?').get(classId, year.id)) return auth.notFound(req, res);
  const before = db.get().prepare('SELECT e.class_id FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ? AND c.year_id = ?').get(st.id, year.id);
  db.get().transaction(() => {
    db.get().prepare('DELETE FROM enrollments WHERE student_id = ? AND class_id IN (SELECT id FROM classes WHERE year_id = ?)').run(st.id, year.id);
    db.get().prepare('INSERT INTO enrollments (student_id, class_id) VALUES (?, ?)').run(st.id, classId);
    db.audit({ entity: 'student', entityId: st.id, action: 'change_class', userId: req.user.id, before, after: { class_id: classId } });
  })();
  back(res, `/admin/students/${st.id}`, 'ok', 'common.saved');
});

// Link an existing parent account, or create a new one, to this student.
r.post('/admin/students/:id/guardians', (req, res) => {
  const st = db.get().prepare('SELECT * FROM students WHERE id = ?').get(int(req.params.id));
  if (!st) return auth.notFound(req, res);
  const relationship = str(req.body.relationship, 40) || null;
  let parentId = int(req.body.parent_id);
  let created = null;
  if (!parentId) {
    const values = { username: str(req.body.username, 40).toLowerCase(), full_name: str(req.body.full_name, 120), phone: str(req.body.phone, 30), role: 'parent', language: req.body.language === 'en' ? 'en' : 'fr' };
    if (!values.full_name || !validUsername(values.username) || (values.phone && !/^[+\d][\d\s-]{5,20}$/.test(values.phone))) return back(res, `/admin/students/${st.id}`, 'error', 'validation.checkFields');
    if (db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) return back(res, `/admin/students/${st.id}`, 'error', 'admin.usernameTaken');
    const u = createUser(values, req.user.id);
    parentId = u.id;
    created = { username: values.username, password: u.password, full_name: values.full_name };
  } else if (!db.get().prepare("SELECT 1 FROM users WHERE id = ? AND role = 'parent'").get(parentId)) return auth.notFound(req, res);
  db.get().prepare('INSERT OR IGNORE INTO guardians (parent_user_id, student_id, relationship) VALUES (?, ?, ?)').run(parentId, st.id, relationship);
  db.audit({ entity: 'guardian', entityId: st.id, action: 'link', userId: req.user.id, after: { parent_user_id: parentId, relationship } });
  if (!created) return back(res, `/admin/students/${st.id}`, 'ok', 'common.saved');
  res.render('admin/student-created', { title: req.t('admin.students'), created: { ...created, id: st.id, parent: true } });
});

r.post('/admin/guardians/:id/delete', (req, res) => {
  const g = db.get().prepare('SELECT * FROM guardians WHERE id = ?').get(int(req.params.id));
  if (!g) return auth.notFound(req, res);
  db.get().prepare('DELETE FROM guardians WHERE id = ?').run(g.id);
  db.audit({ entity: 'guardian', entityId: g.student_id, action: 'unlink', userId: req.user.id, before: g });
  back(res, `/admin/students/${g.student_id}`, 'ok', 'admin.unlinked');
});

/* ---------- Teaching assignments and timetable ---------- */

r.get('/admin/timetable', (req, res) => {
  const year = res.locals.year;
  if (!year) return back(res, '/admin/structure', 'info', 'admin.createYearFirst');
  const d = db.get();
  const classId = int(req.query.class);
  const classes = d.prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id);
  const terms = d.prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(year.id);
  const assignments = d.prepare(`SELECT ta.*, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    WHERE c.year_id = ? AND (? IS NULL OR c.id = ?) ORDER BY c.name, s.name_en`).all(year.id, classId, classId);
  const slotStmt = d.prepare('SELECT ts.*, t.name AS term_name FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id WHERE ts.assignment_id = ? ORDER BY t.ordinal, ts.day_of_week, ts.start_time');
  assignments.forEach((a) => { a.slots = slotStmt.all(a.id); });
  res.render('admin/timetable', {
    title: req.t('admin.timetable'), classes, classId, terms, assignments,
    teachers: d.prepare("SELECT id, full_name FROM users WHERE role = 'teacher' AND active = 1 ORDER BY full_name").all(),
    subjects: d.prepare('SELECT * FROM subjects WHERE active = 1 ORDER BY name_en').all(),
  });
});

r.post('/admin/assignments', (req, res) => {
  const year = res.locals.year;
  const v = { teacher_id: int(req.body.teacher_id), class_id: int(req.body.class_id), subject_id: int(req.body.subject_id) };
  const url = `/admin/timetable?class=${v.class_id || ''}`;
  const ok = v.teacher_id && v.class_id && v.subject_id
    && db.get().prepare("SELECT 1 FROM users WHERE id = ? AND role = 'teacher'").get(v.teacher_id)
    && db.get().prepare('SELECT 1 FROM classes WHERE id = ? AND year_id = ?').get(v.class_id, year.id)
    && db.get().prepare('SELECT 1 FROM subjects WHERE id = ?').get(v.subject_id);
  if (!ok) return back(res, url, 'error', 'validation.checkFields');
  const info = db.get().prepare('INSERT OR IGNORE INTO teaching_assignments (teacher_id, class_id, subject_id) VALUES (@teacher_id, @class_id, @subject_id)').run(v);
  if (info.changes) db.audit({ entity: 'teaching_assignment', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, url, info.changes ? 'ok' : 'info', info.changes ? 'common.saved' : 'admin.duplicate');
});

r.post('/admin/slots', (req, res) => {
  const v = { assignment_id: int(req.body.assignment_id), term_id: int(req.body.term_id), day_of_week: int(req.body.day_of_week), start_time: str(req.body.start_time, 5), end_time: str(req.body.end_time, 5), room: str(req.body.room, 40) || null };
  const a = db.get().prepare('SELECT * FROM teaching_assignments WHERE id = ?').get(v.assignment_id);
  const url = `/admin/timetable?class=${a ? a.class_id : ''}#a-${v.assignment_id}`;
  if (!a || !v.term_id || !(v.day_of_week >= 1 && v.day_of_week <= 7) || !isTime(v.start_time) || !isTime(v.end_time) || minutesBetween(v.start_time, v.end_time) <= 0) {
    return back(res, url, 'error', 'validation.checkFields');
  }
  // Warn about clashes: same teacher or same class at an overlapping time in the same term.
  const clash = db.get().prepare(`SELECT 1 FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id
    WHERE ts.term_id = @term_id AND ts.day_of_week = @day_of_week AND ts.start_time < @end_time AND ts.end_time > @start_time
    AND (ta.teacher_id = @teacher_id OR ta.class_id = @class_id) LIMIT 1`).get({ ...v, teacher_id: a.teacher_id, class_id: a.class_id });
  if (clash) return back(res, url, 'error', 'admin.slotClash');
  const info = db.get().prepare('INSERT INTO timetable_slots (assignment_id, term_id, day_of_week, start_time, end_time, room) VALUES (@assignment_id, @term_id, @day_of_week, @start_time, @end_time, @room)').run(v);
  db.audit({ entity: 'timetable_slot', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: v });
  back(res, url, 'ok', 'common.saved');
});

r.post('/admin/slots/:id/delete', (req, res) => {
  const s = db.get().prepare('SELECT ts.*, ta.class_id FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id WHERE ts.id = ?').get(int(req.params.id));
  if (!s) return auth.notFound(req, res);
  const url = `/admin/timetable?class=${s.class_id}#a-${s.assignment_id}`;
  // Recorded sessions keep pointing at the slot, so a used slot cannot be removed.
  if (db.get().prepare('SELECT 1 FROM class_sessions WHERE slot_id = ?').get(s.id)) return back(res, url, 'error', 'admin.slotInUse');
  db.get().prepare('DELETE FROM timetable_slots WHERE id = ?').run(s.id);
  db.audit({ entity: 'timetable_slot', entityId: s.id, action: 'delete', userId: req.user.id, before: s });
  back(res, url, 'ok', 'common.deleted');
});

/* ---------- Settings ---------- */

const SETTING_RULES = {
  school_name: (v) => v.length >= 2 && v.length <= 120,
  timezone: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } },
  currency: (v) => /^[A-Z]{3}$/.test(v),
  default_language: (v) => ['en', 'fr'].includes(v),
  parent_absence_alert: (v) => ['none', 'in_app'].includes(v),
  prepare_sms_for_absences: (v) => ['0', '1'].includes(v),
  absence_alert_statuses: (v) => v.split(',').every((x) => ['absent', 'late'].includes(x)),
  show_attendance_to_parents: (v) => ['0', '1'].includes(v),
  show_attendance_to_students: (v) => ['0', '1'].includes(v),
  show_progress_to_students: (v) => ['0', '1'].includes(v),
  repeat_absence_threshold: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1,
  repeat_absence_window_days: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1,
};
const CHECKBOXES = ['prepare_sms_for_absences', 'show_attendance_to_parents', 'show_attendance_to_students', 'show_progress_to_students'];

r.get('/admin/settings', (req, res) => res.render('admin/settings', { title: req.t('admin.settings'), errors: [] }));

r.post('/admin/settings', (req, res) => {
  const before = db.getSettings();
  const next = {};
  const errors = [];
  for (const key of Object.keys(SETTING_RULES)) {
    let v;
    if (CHECKBOXES.includes(key)) v = req.body[key] === '1' ? '1' : '0';
    else if (key === 'absence_alert_statuses') v = [].concat(req.body[key] || ['absent']).join(',');
    else v = str(req.body[key], 120);
    if (key === 'currency') v = v.toUpperCase();
    if (!SETTING_RULES[key](v)) errors.push({ field: key, key: 'validation.checkFields' });
    next[key] = v;
  }
  if (errors.length) {
    res.locals.settings = { ...before, ...next };
    return res.status(400).render('admin/settings', { title: req.t('admin.settings'), errors });
  }
  db.get().transaction(() => {
    for (const [k, v] of Object.entries(next)) db.setSetting(k, v);
    db.audit({ entity: 'settings', action: 'update', userId: req.user.id, before, after: next });
  })();
  back(res, '/admin/settings', 'ok', 'common.saved');
});

module.exports = r;
