'use strict';
// Authentication, sessions, CSRF protection and role checks.
const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'sid';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// A dummy hash so failed logins for unknown usernames take the same time as wrong passwords.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.get().prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, csrf, expires);
  return { token, csrf, expires };
}

function destroySession(token) {
  if (token) db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

function cookieOptions(maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function setSessionCookie(res, token) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(SESSION_DAYS * 86400)}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
}

// Loads the logged-in user (if any) into req.user.
function loadSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[SESSION_COOKIE];
  req.user = null;
  if (token) {
    const row = db.get().prepare(`SELECT s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`).get(sha256(token));
    if (row && row.expires_at > new Date().toISOString() && row.active) {
      req.csrfToken = row.csrf_token;
      delete row.password_hash;
      delete row.csrf_token;
      req.user = row;
      req.sessionToken = token;
    } else if (row) {
      destroySession(token);
      clearSessionCookie(res);
    }
  }
  next();
}

// Logged-out forms (login page) use a double-submit cookie for CSRF.
function ensureAnonCsrf(req, res) {
  let tok = req.cookies.pre_csrf;
  if (!tok || !/^[A-Za-z0-9_-]{20,}$/.test(tok)) {
    tok = crypto.randomBytes(24).toString('base64url');
    res.append('Set-Cookie', `pre_csrf=${tok}; ${cookieOptions(3600)}`);
  }
  return tok;
}

function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  const expected = req.user ? req.csrfToken : req.cookies.pre_csrf;
  if (!sent || !expected || sent.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    return res.status(403).render('error', { title: res.locals.t('errors.forbiddenTitle'), message: res.locals.t('errors.csrf') });
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  // Users with a temporary password must change it before anything else.
  if (req.user.must_change_password && !req.path.startsWith('/account/password') && req.path !== '/logout' && !req.path.startsWith('/lang')) {
    return res.redirect('/account/password');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return forbidden(req, res);
    next();
  };
}

function forbidden(req, res) {
  return res.status(403).render('error', { title: res.locals.t('errors.forbiddenTitle'), message: res.locals.t('errors.forbidden') });
}

// Not found is used for records the user may not see, so the response does not reveal
// whether another family's record exists.
function notFound(req, res) {
  return res.status(404).render('error', { title: res.locals.t('errors.notFoundTitle'), message: res.locals.t('errors.notFound') });
}

// Very small in-memory limiter for login attempts (per IP + username).
const attempts = new Map();
function loginLimited(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60000) return false;
  return rec.count >= 8;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60000) attempts.set(key, { first: now, count: 1 });
  else rec.count++;
}
function clearLoginFailures(key) { attempts.delete(key); }

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, destroySession, setSessionCookie, clearSessionCookie,
  loadSession, csrfProtect, ensureAnonCsrf, requireLogin, requireRole, forbidden, notFound,
  loginLimited, recordLoginFailure, clearLoginFailures,
};
