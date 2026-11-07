'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const brand = require('./brand');
const { translator, formatters, LANGS } = require('./i18n');
const { todayIn } = require('./util');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

  // Security headers. No inline scripts are used, so a strict CSP is possible.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
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
    console.error(err);
    const t = res.locals.t || translator('en');
    const status = err.status || 500;
    res.status(status).render('error', {
      title: t(status === 413 ? 'errors.tooLargeTitle' : 'errors.serverTitle'),
      message: t(status === 413 ? 'errors.tooLarge' : 'errors.server'),
    });
  });
  return app;
}

module.exports = { createApp };
