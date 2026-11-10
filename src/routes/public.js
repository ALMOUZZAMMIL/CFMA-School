'use strict';
// Public pages: the welcome page, "Request an account" and "Forgot password".
// Neither form grants access. Each creates a request that an administrator reviews,
// verifies in person or by phone, and then acts on from Administration > Access requests.
const express = require('express');
const db = require('../db');
const { Validator, str } = require('../util');

const r = express.Router();
const ROLES = ['parent', 'teacher', 'student'];

// Welcome page for visitors; signed-in users go straight to their dashboard.
r.get('/', (req, res, next) => {
  if (req.user) return next();
  res.render('public/landing', { title: '' });
});

// Simple per-IP limit on public submissions (6 an hour), to stop the queue being flooded.
// Expired entries are removed regularly and the map is capped, so memory stays bounded.
const HOUR = 3600000;
const MAX_IPS = 10000;
const hits = new Map();
function tooMany(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < HOUR);
  if (list.length) hits.set(ip, list); else hits.delete(ip);
  return list.length >= 6;
}
function count(ip, now = Date.now()) {
  const list = hits.get(ip) || [];
  list.push(now);
  hits.set(ip, list);
  if (hits.size > MAX_IPS) pruneHits(now);
}
function pruneHits(now = Date.now()) {
  for (const [ip, list] of hits) {
    const keep = list.filter((t) => now - t < HOUR);
    if (keep.length) hits.set(ip, keep); else hits.delete(ip);
  }
  while (hits.size > MAX_IPS) hits.delete(hits.keys().next().value);
  return hits.size;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE = /^[+\d][\d\s.-]{5,20}$/;

function registerForm(req, res, { values = {}, errors = [], status = 200 }) {
  res.status(status).render('public/register', { title: req.t('access.requestTitle'), values: { role_requested: 'parent', language: res.locals.lang, ...values }, errors, roles: ROLES });
}

r.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  if (res.locals.settings.allow_account_requests !== '1') return res.render('public/closed', { title: req.t('access.requestTitle') });
  registerForm(req, res, {});
});

r.post('/register', (req, res) => {
  if (res.locals.settings.allow_account_requests !== '1') return res.redirect('/register');
  const values = {
    role_requested: str(req.body.role_requested, 10),
    full_name: str(req.body.full_name, 120),
    phone: str(req.body.phone, 30),
    email: str(req.body.email, 200).toLowerCase(),
    language: req.body.language === 'en' ? 'en' : 'fr',
    details: str(req.body.details, 1000),
    confirm: req.body.confirm === '1',
  };
  // Bots tend to fill every field, including this hidden one: accept silently, store nothing.
  if (str(req.body.website, 200)) return res.render('public/request-sent', { title: req.t('access.requestTitle'), kind: 'account' });
  const v = new Validator()
    .required(values.role_requested, 'role_requested').oneOf(values.role_requested, ROLES, 'role_requested')
    .required(values.full_name, 'full_name')
    .required(values.phone, 'phone')
    .required(values.details, 'details');
  if (values.full_name) v.check(values.full_name.length >= 3, 'full_name', 'validation.tooShort');
  if (values.phone) v.check(PHONE.test(values.phone), 'phone', 'validation.phone');
  if (values.email) v.check(EMAIL.test(values.email), 'email', 'validation.email');
  v.check(values.confirm, 'confirm', 'access.mustConfirm');
  if (!v.ok) return registerForm(req, res, { values, errors: v.errors, status: 400 });
  if (tooMany(req.ip)) return registerForm(req, res, { values, errors: [{ field: 'form', key: 'access.tooMany' }], status: 429 });
  count(req.ip);
  db.get().prepare(`INSERT INTO access_requests (kind, role_requested, full_name, phone, email, language, details)
    VALUES ('account', @role_requested, @full_name, @phone, @email, @language, @details)`).run({ ...values, email: values.email || null });
  res.render('public/request-sent', { title: req.t('access.requestTitle'), kind: 'account' });
});

r.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect('/account/password');
  res.render('public/forgot', { title: req.t('access.forgotTitle'), values: {}, errors: [] });
});

r.post('/forgot-password', (req, res) => {
  const values = { identifier: str(req.body.identifier, 120), phone: str(req.body.phone, 30) };
  if (str(req.body.website, 200)) return res.render('public/request-sent', { title: req.t('access.forgotTitle'), kind: 'password_reset' });
  const v = new Validator().required(values.identifier, 'identifier');
  if (values.phone) v.check(PHONE.test(values.phone), 'phone', 'validation.phone');
  if (!v.ok) return res.status(400).render('public/forgot', { title: req.t('access.forgotTitle'), values, errors: v.errors });
  if (tooMany(req.ip)) return res.status(429).render('public/forgot', { title: req.t('access.forgotTitle'), values, errors: [{ field: 'form', key: 'access.tooMany' }] });
  count(req.ip);
  // The same answer is shown whether or not the account exists.
  db.get().prepare("INSERT INTO access_requests (kind, identifier, phone, language) VALUES ('password_reset', ?, ?, ?)")
    .run(values.identifier, values.phone || null, res.locals.lang);
  res.render('public/request-sent', { title: req.t('access.forgotTitle'), kind: 'password_reset' });
});

module.exports = r;
module.exports.limiter = { tooMany, count, pruneHits, hits, MAX_IPS };
