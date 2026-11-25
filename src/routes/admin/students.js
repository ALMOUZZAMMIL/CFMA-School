'use strict';
// Administration: Students, enrolment and guardians.
// Moved unchanged from the former src/routes/admin.js. Admin role is required (see index.js).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const { Validator, int, str } = require('../../util');
const { back, createUser, validUsername } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
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

module.exports = r;
