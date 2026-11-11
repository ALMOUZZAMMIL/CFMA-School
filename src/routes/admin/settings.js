'use strict';
// Administration: School settings.
// Moved unchanged from the former src/routes/admin.js. Admin role is required (see index.js).
const express = require('express');
const db = require('../../db');
const auth = require('../../auth');
const brand = require('../../brand');
const { str } = require('../../util');
const { back, EMAIL } = require('./shared');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
/* ---------- Settings ---------- */

const SETTING_RULES = {
  school_name: (v) => v.length >= 2 && v.length <= 120,
  school_motto: (v) => v.length <= 120,
  school_address: (v) => v.length <= 200,
  school_phone: (v) => v === '' || /^[+\d][\d\s.-]{5,20}$/.test(v),
  school_email: (v) => v === '' || EMAIL.test(v),
  brand_primary: (v) => brand.HEX.test(v) && brand.contrast(v, '#ffffff') >= 4.5,
  brand_accent: (v) => brand.HEX.test(v),
  brand_secondary: (v) => brand.HEX.test(v),
  allow_account_requests: (v) => ['0', '1'].includes(v),
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
const CHECKBOXES = ['allow_account_requests', 'prepare_sms_for_absences', 'show_attendance_to_parents', 'show_attendance_to_students', 'show_progress_to_students'];

r.get('/admin/settings', (req, res) => res.render('admin/settings', { title: req.t('admin.settings'), errors: [] }));

r.post('/admin/settings', (req, res) => {
  const before = db.getSettings();
  const next = {};
  const errors = [];
  for (const key of Object.keys(SETTING_RULES)) {
    let v;
    if (CHECKBOXES.includes(key)) v = req.body[key] === '1' ? '1' : '0';
    else if (key === 'absence_alert_statuses') v = [].concat(req.body[key] || ['absent']).join(',');
    else v = str(req.body[key], 200);
    if (key === 'currency') v = v.toUpperCase();
    if (key.startsWith('brand_')) v = v.toLowerCase();
    if (!SETTING_RULES[key](v)) errors.push({ field: key, key: key === 'brand_primary' ? 'settings.primaryContrast' : 'validation.checkFields' });
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
