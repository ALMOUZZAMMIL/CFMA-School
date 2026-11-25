'use strict';
// School announcements: notices, exam dates, meetings, events and deadlines.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { visibleAnnouncements } = require('./home');
const { Validator, int, str } = require('../util');

const r = express.Router();
const CATEGORIES = ['notice', 'exam', 'meeting', 'event', 'deadline'];
const AUDIENCES = ['teacher', 'student', 'parent'];

// datetime-local value ("2026-11-07T08:00") in school time -> UTC "YYYY-MM-DD HH:MM:SS"
function localToUtc(value, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const asUtc = new Date(`${value}:00Z`);
  // Find the zone offset at that moment.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(asUtc);
  const g = (k) => parts.find((p) => p.type === k).value;
  const shown = new Date(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:00Z`);
  const offset = shown - asUtc;
  return new Date(asUtc - offset).toISOString().replace('T', ' ').slice(0, 19);
}

function utcToLocal(ts, timezone) {
  if (!ts) return '';
  const d = new Date(`${ts.replace(' ', 'T')}Z`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (k) => parts.find((p) => p.type === k).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

r.get('/announcements', (req, res) => {
  if (req.user.role === 'bursar') return auth.forbidden(req, res);
  res.render('announcements/list', { title: req.t('announcements.title'), rows: visibleAnnouncements(req.user, 100) });
});

r.get('/announcements/manage', auth.requireRole('admin'), (req, res) => {
  const rows = db.get().prepare(`SELECT a.*, c.name AS class_name, u.full_name AS author FROM announcements a LEFT JOIN classes c ON c.id = a.class_id
    JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC LIMIT 300`).all();
  res.render('announcements/manage', { title: req.t('announcements.manageTitle'), rows });
});

function form(req, res, { a, errors = [], status = 200 }) {
  const year = res.locals.year;
  const classes = year ? db.get().prepare('SELECT id, name FROM classes WHERE year_id = ? ORDER BY name').all(year.id) : [];
  res.status(status).render('announcements/form', { title: req.t('announcements.formTitle'), a, errors, classes, categories: CATEGORIES, audiences: AUDIENCES });
}

r.get('/announcements/new', auth.requireRole('admin'), (req, res) => {
  const tz = res.locals.settings.timezone;
  form(req, res, { a: { category: 'notice', audience: 'teacher,student,parent', publish_local: utcToLocal(new Date().toISOString().replace('T', ' ').slice(0, 19), tz), status: 'draft' } });
});

function readForm(req, res) {
  const tz = res.locals.settings.timezone;
  const audienceList = [].concat(req.body.audience || []).filter((x) => AUDIENCES.includes(x));
  const a = {
    category: str(req.body.category, 20),
    title_en: str(req.body.title_en, 200) || null,
    body_en: str(req.body.body_en, 5000) || null,
    title_fr: str(req.body.title_fr, 200) || null,
    body_fr: str(req.body.body_fr, 5000) || null,
    audience: audienceList.join(','),
    class_id: int(req.body.class_id),
    publish_local: str(req.body.publish_at, 16),
    expires_local: str(req.body.expires_at, 16),
    status: req.body.action === 'publish' ? 'published' : 'draft',
  };
  a.publish_at = localToUtc(a.publish_local, tz);
  a.expires_at = a.expires_local ? localToUtc(a.expires_local, tz) : null;
  const v = new Validator().required(a.category, 'category').oneOf(a.category, CATEGORIES, 'category');
  v.check(a.title_en || a.title_fr, 'title_en', 'announcements.needTitle');
  v.check(!a.title_en || a.body_en, 'body_en', 'validation.required');
  v.check(!a.title_fr || a.body_fr, 'body_fr', 'validation.required');
  v.check(audienceList.length > 0, 'audience', 'announcements.needAudience');
  v.check(!!a.publish_at, 'publish_at', 'validation.date');
  if (a.expires_local) v.check(!!a.expires_at && a.expires_at > a.publish_at, 'expires_at', 'announcements.expiryAfterPublish');
  if (a.class_id) v.check(!!db.get().prepare('SELECT 1 FROM classes WHERE id = ?').get(a.class_id), 'class_id', 'validation.choice');
  return { a, v };
}

const COLS = ['category', 'title_en', 'body_en', 'title_fr', 'body_fr', 'audience', 'class_id', 'publish_at', 'expires_at', 'status'];

r.post('/announcements', auth.requireRole('admin'), (req, res) => {
  const { a, v } = readForm(req, res);
  if (!v.ok) return form(req, res, { a, errors: v.errors, status: 400 });
  const info = db.get().prepare(`INSERT INTO announcements (${COLS.join(',')}, created_by) VALUES (${COLS.map((c) => '@' + c).join(',')}, @uid)`).run({ ...a, uid: req.user.id });
  db.audit({ entity: 'announcement', entityId: Number(info.lastInsertRowid), action: 'create', userId: req.user.id, after: a });
  res.flash('ok', a.status === 'published' ? 'announcements.published' : 'announcements.savedDraft');
  res.redirect('/announcements/manage');
});

r.get('/announcements/:id/edit', auth.requireRole('admin'), (req, res) => {
  const a = db.get().prepare('SELECT * FROM announcements WHERE id = ?').get(int(req.params.id));
  if (!a) return auth.notFound(req, res);
  const tz = res.locals.settings.timezone;
  form(req, res, { a: { ...a, publish_local: utcToLocal(a.publish_at, tz), expires_local: utcToLocal(a.expires_at, tz) } });
});

r.post('/announcements/:id', auth.requireRole('admin'), (req, res) => {
  const before = db.get().prepare('SELECT * FROM announcements WHERE id = ?').get(int(req.params.id));
  if (!before) return auth.notFound(req, res);
  const { a, v } = readForm(req, res);
  if (!v.ok) return form(req, res, { a: { ...a, id: before.id }, errors: v.errors, status: 400 });
  db.get().prepare(`UPDATE announcements SET ${COLS.map((c) => `${c}=@${c}`).join(',')}, updated_at = datetime('now') WHERE id = @id`).run({ ...a, id: before.id });
  db.audit({ entity: 'announcement', entityId: before.id, action: 'update', userId: req.user.id, before, after: a });
  res.flash('ok', a.status === 'published' ? 'announcements.published' : 'announcements.savedDraft');
  res.redirect('/announcements/manage');
});

r.post('/announcements/:id/archive', auth.requireRole('admin'), (req, res) => {
  const a = db.get().prepare('SELECT * FROM announcements WHERE id = ?').get(int(req.params.id));
  if (!a) return auth.notFound(req, res);
  db.get().prepare("UPDATE announcements SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(a.id);
  db.audit({ entity: 'announcement', entityId: a.id, action: 'archive', userId: req.user.id, before: { status: a.status } });
  res.flash('ok', 'announcements.archived');
  res.redirect('/announcements/manage');
});

// Prepares SMS text for parents of the targeted classes. It is NOT sent: no provider is connected.
r.post('/announcements/:id/prepare-sms', auth.requireRole('admin'), (req, res) => {
  const a = db.get().prepare('SELECT * FROM announcements WHERE id = ?').get(int(req.params.id));
  if (!a || a.status !== 'published' || !a.audience.split(',').includes('parent')) return auth.notFound(req, res);
  const year = res.locals.year;
  const parents = db.get().prepare(`SELECT DISTINCT g.parent_user_id, u.language FROM guardians g JOIN users u ON u.id = g.parent_user_id
    JOIN enrollments e ON e.student_id = g.student_id JOIN classes c ON c.id = e.class_id
    WHERE u.active = 1 AND c.year_id = ? AND (? IS NULL OR c.id = ?)`).all(year.id, a.class_id, a.class_id);
  const ins = db.get().prepare("INSERT OR IGNORE INTO message_outbox (channel, recipient_user_id, body, source) VALUES ('sms', ?, ?, ?)");
  let n = 0;
  for (const p of parents) {
    const title = p.language === 'en' ? (a.title_en || a.title_fr) : (a.title_fr || a.title_en);
    n += ins.run(p.parent_user_id, `${res.locals.settings.school_name}: ${title}`.slice(0, 300), `announcement:${a.id}`).changes;
  }
  db.audit({ entity: 'announcement', entityId: a.id, action: 'prepare_sms', userId: req.user.id, after: { prepared: n } });
  res.flash('info', 'outbox.prepared');
  res.redirect('/admin/outbox');
});

r.get('/announcements/:id', (req, res) => {
  const id = int(req.params.id);
  const a = req.user.role === 'admin'
    ? db.get().prepare('SELECT a.*, c.name AS class_name FROM announcements a LEFT JOIN classes c ON c.id = a.class_id WHERE a.id = ?').get(id)
    : visibleAnnouncements(req.user, 1000).find((x) => x.id === id);
  if (!a) return auth.notFound(req, res);
  res.render('announcements/view', { title: req.t('announcements.title'), a });
});

module.exports = r;
module.exports.localToUtc = localToUtc;
