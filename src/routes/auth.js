'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const guard = require('../login-guard');
const { LANGS } = require('../i18n');
const { str } = require('../util');

const r = express.Router();

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

// Sign-in status for the page script that warns before an idle sign-out. Reading it does not
// count as activity. Same-origin only (no CORS), never cached. The form token is included so
// a page left open can be saved after the person signs in again in another tab.
r.get('/session/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, user: req.user.id, remainingSeconds: Math.max(0, Math.floor(req.sessionRemainingMs / 1000)), csrf: req.csrfToken });
});

// "Stay signed in": an explicit action, so it counts as activity. Needs the form token.
r.post('/session/keepalive', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ signedIn: false });
  db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(auth.dbTime(), require('crypto').createHash('sha256').update(req.sessionToken).digest('hex'));
  res.json({ signedIn: true, user: req.user.id, remainingSeconds: Math.floor(auth.idleLimitMs(req.user.role) / 1000), csrf: req.csrfToken });
});

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: res.locals.t('auth.loginTitle'), next: safeNext(req.query.next), error: null, username: '' });
});

r.post('/login', (req, res) => {
  const username = str(req.body.username, 200);
  const password = String(req.body.password || '').slice(0, 200);
  const next = safeNext(req.body.next);
  const fail = (msgKey, status = 401) => res.status(status).render('login', {
    title: res.locals.t('auth.loginTitle'), next, error: res.locals.t(msgKey), username,
  });
  // Sign in with the username or, if one is on the account, the email address.
  const user = db.get().prepare('SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email = ? COLLATE NOCASE) LIMIT 1').get(username, username);
  const attempt = { ip: req.ip, account: guard.accountKey(user, username), device: guard.knownDevice(req.cookies[guard.DEVICE_COOKIE], user) };
  if (guard.blocked(attempt)) return fail('auth.tooManyAttempts', 429);
  const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH);
  if (!user || !ok || !user.active) {
    guard.recordFailure(attempt);
    return fail('auth.invalid');
  }
  guard.recordSuccess(attempt);
  const devices = guard.rememberDevice(req.cookies[guard.DEVICE_COOKIE], user);
  res.append('Set-Cookie', `${guard.DEVICE_COOKIE}=${devices}; ${auth.cookieOptions(guard.DEVICE_DAYS * 86400)}`);
  const s = auth.createSession(user.id);
  auth.setSessionCookie(res, s.token, s.maxAgeSeconds);
  db.get().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  res.redirect(user.must_change_password ? '/account/password' : next);
});

r.post('/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.redirect('/login');
});

// Language switch: saved on the account when logged in, in a cookie otherwise.
r.post('/lang', (req, res) => {
  const lang = LANGS.includes(req.body.lang) ? req.body.lang : 'fr';
  if (req.user) db.get().prepare('UPDATE users SET language = ? WHERE id = ?').run(lang, req.user.id);
  res.append('Set-Cookie', `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.redirect(safeNext(req.body.back));
});

r.get('/account/password', auth.requireLogin, (req, res) => {
  res.render('password', { title: res.locals.t('auth.changePassword'), errors: [] });
});

r.post('/account/password', auth.requireLogin, (req, res) => {
  const t = res.locals.t;
  const current = String(req.body.current || '');
  const pw = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const row = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const errors = [];
  if (!auth.verifyPassword(current, row.password_hash)) errors.push(t('auth.currentWrong'));
  if (pw.length < 8) errors.push(t('auth.tooShort'));
  if (pw !== confirm) errors.push(t('auth.mismatch'));
  if (pw && pw === current) errors.push(t('auth.sameAsOld'));
  if (errors.length) return res.status(400).render('password', { title: t('auth.changePassword'), errors });
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(pw), req.user.id);
  // Sign out other devices.
  db.get().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(req.user.id, require('crypto').createHash('sha256').update(req.sessionToken).digest('hex'));
  db.audit({ entity: 'user', entityId: req.user.id, action: 'password_changed', userId: req.user.id });
  res.flash('ok', 'auth.passwordChanged');
  res.redirect('/');
});

module.exports = r;
