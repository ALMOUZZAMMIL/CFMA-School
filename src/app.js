'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const config = require('./config');
const log = require('./log');
const migrate = require('./migrate');
const auth = require('./auth');
const brand = require('./brand');
const { translator, formatters, LANGS } = require('./i18n');
const { todayIn } = require('./util');

function createApp() {
  const cfg = config.get();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  // A short reference for every request, shown on error pages and written to the logs,
  // so a problem a user reports can be found. One access-log line per request.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.id = crypto.randomBytes(6).toString('hex');
    res.locals.requestId = req.id;
    res.set('X-Request-Id', req.id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const fields = { reqId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), user: req.user ? req.user.id : undefined };
      if (res.statusCode >= 500) log.error('request', fields);
      else if (req.path !== '/healthz') log.info('request', fields);
    });
    next();
  });

  // Security headers. No inline scripts are used, so a strict CSP is possible.
  app.use((req, res, next) => {
    // HTTPS only, once deployed: tells browsers never to use plain HTTP for this site.
    if (cfg.production && cfg.hstsMaxAge > 0) res.set('Strict-Transport-Security', `max-age=${cfg.hstsMaxAge}; includeSubDomains`);
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  // Health check for monitoring and hosting platforms. No sign-in, no session, no personal data.
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const d = db.get();
      d.prepare('SELECT 1').get();
      res.json({ status: 'ok', database: 'ok', schemaVersion: migrate.currentVersion(d), uptimeSeconds: Math.round(process.uptime()) });
    } catch (err) {
      log.error('health check failed', { reqId: req.id, err });
      res.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });

  // Brand colours from the settings, as CSS variables (no inline styles under the CSP).
  app.get('/brand.css', (req, res) => {
    res.type('text/css').set('Cache-Control', 'no-cache').send(brand.css(db.getSettings()));
  });
  // Version tag on the stylesheet and script links, so browsers fetch the new files after an update
  // instead of keeping an old copy for 7 days.
  const assetV = ['style.css', 'app.js'].map((f) => Math.floor(fs.statSync(path.join(__dirname, '..', 'public', f)).mtimeMs).toString(36)).join('');
  app.use((req, res, next) => { res.locals.assetV = assetV; next(); });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
  app.use(express.urlencoded({ extended: false, limit: '300kb', parameterLimit: 5000 }));
  app.use(auth.loadSession);

  // Language, formatting helpers, flash messages and shared view data.
  app.use((req, res, next) => {
    const settings = db.getSettings();
    let lang = req.user ? req.user.language : req.cookies.lang;
    if (!LANGS.includes(lang)) {
      const accept = String(req.headers['accept-language'] || '').slice(0, 2).toLowerCase();
      lang = LANGS.includes(accept) ? accept : settings.default_language;
    }
    const t = translator(lang);
    const fmt = formatters(lang, settings.timezone);
    res.locals.t = t;
    res.locals.fmt = fmt;
    res.locals.lang = lang;
    res.locals.user = req.user;
    res.locals.settings = settings;
    res.locals.today = todayIn(settings.timezone);
    res.locals.path = req.path;
    res.locals.originalUrl = req.originalUrl;
    res.locals.csrf = req.user ? req.csrfToken : auth.ensureAnonCsrf(req, res);
    res.locals.year = db.currentYear();
    res.locals.logoUrl = brand.logoUrl();
    res.locals.schoolInitials = brand.initials(settings.school_name);
    // Localised name of a bilingual record (subjects, sections).
    res.locals.ln = (row, base = 'name') => (row ? (row[`${base}_${lang}`] || row[`${base}_en`] || row[`${base}_fr`] || '') : '');
    res.locals.flash = null;
    if (req.cookies.flash) {
      const [type, key] = req.cookies.flash.split('|');
      if (/^(ok|error|info)$/.test(type) && /^[\w.]+$/.test(key || '')) res.locals.flash = { type, message: t(key) };
      res.append('Set-Cookie', 'flash=; Path=/; Max-Age=0; SameSite=Lax');
    }
    res.flash = (type, key) => res.append('Set-Cookie', `flash=${type}|${key}; Path=/; Max-Age=60; SameSite=Lax; HttpOnly`);
    res.locals.unread = req.user
      ? db.get().prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n : 0;
    req.t = t;
    next();
  });

  app.use(auth.csrfProtect);

  app.use(require('./routes/auth'));
  app.use(require('./routes/public'));
  app.use(auth.requireLogin);
  app.use(require('./routes/home'));
  app.use(require('./routes/teaching'));
  app.use(require('./routes/progress'));
  app.use(require('./routes/attendance'));
  app.use(require('./routes/announcements'));
  app.use(require('./routes/family'));
  app.use(require('./routes/plans'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/admin'));

  app.use((req, res) => auth.notFound(req, res));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) log.error('unhandled error', { reqId: req.id, method: req.method, path: req.path, err });
    else log.warn('request error', { reqId: req.id, method: req.method, path: req.path, status, msg: err.message });
    const t = res.locals.t || translator('en');
    if (!res.locals.t) { res.locals.t = t; res.locals.lang = 'en'; }
    const opts = {
      title: t(status === 413 ? 'errors.tooLargeTitle' : 'errors.serverTitle'),
      message: t(status === 413 ? 'errors.tooLarge' : 'errors.server'),
      showRef: status >= 500,
    };
    res.status(status).render('error', opts, (renderErr, html) => {
      // If the page itself cannot be drawn (for example the database is down), answer in plain text.
      if (renderErr) return res.type('text/plain').send(`${opts.title}. ${opts.message} (ref ${req.id})`);
      res.send(html);
    });
  });
  return app;
}

module.exports = { createApp };
