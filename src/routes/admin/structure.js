'use strict';
// Administration: School structure: years, terms, closures, sections, subjects, classes.
// Moved unchanged from the former src/routes/admin.js. Admin role is required (see index.js).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const { int, str, isDate } = require('../../util');
const { back } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
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

module.exports = r;
