'use strict';
// Authentication, sessions, CSRF protection and role checks.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const SESSION_COOKIE = 'sid';
const PRIVILEGED = ['admin', 'bursar'];
// Last activity is written at most once a minute per session, to keep database writes low.
const TOUCH_EVERY_MS = 60000;

// SQLite's datetime('now') gives "YYYY-MM-DD HH:MM:SS" in UTC; JavaScript writes ISO strings.
function parseDbTime(s) {
  if (!s) return NaN;
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}
function dbTime(ms = Date.now()) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

// How long a sign-in can last for this role, in milliseconds.
function maxLifetimeMs(role) {
  const cfg = config.get();
  return PRIVILEGED.includes(role) ? cfg.privilegedMaxHours * 3600000 : cfg.sessionDays * 86400000;
}
function idleLimitMs(role) {
  const m = config.get().idleMinutes[role];
  return (m || 60) * 60000;
}

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
  const u = db.get().prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const lifetime = maxLifetimeMs(u && u.role);
  const expires = new Date(Date.now() + lifetime).toISOString();
  db.get().prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, csrf, expires, dbTime());
  return { token, csrf, expires, maxAgeSeconds: Math.floor(lifetime / 1000) };
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
  const secure = config.get().cookieSecure;
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(maxAgeSeconds || config.get().sessionDays * 86400)}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
}

// Loads the logged-in user (if any) into req.user. A sign-in ends when it passes its expiry
// time, when the account is deactivated, or after the role's idle time without any request.
function loadSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[SESSION_COOKIE];
  req.user = null;
  if (token) {
    const hash = sha256(token);
    const row = db.get().prepare(`SELECT s.csrf_token, s.expires_at, s.last_seen_at, s.created_at AS session_created_at, u.* FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
    const now = Date.now();
    if (row) {
      const lastSeen = parseDbTime(row.last_seen_at || row.session_created_at);
      const idle = !(now - lastSeen < idleLimitMs(row.role));
      // Also caps sessions created before a role's lifetime was shortened.
      const tooOld = !(now - parseDbTime(row.session_created_at) < maxLifetimeMs(row.role));
      if (row.expires_at > new Date(now).toISOString() && row.active && !idle && !tooOld) {
        // A status check (used by the page to warn before sign-out) must not count as activity.
        const touch = req.path !== '/session/status' && now - lastSeen >= TOUCH_EVERY_MS;
        if (touch) db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(dbTime(now), hash);
        const seen = touch ? now : lastSeen;
        req.sessionRemainingMs = Math.min(seen + idleLimitMs(row.role), parseDbTime(row.session_created_at) + maxLifetimeMs(row.role), Date.parse(row.expires_at)) - now;
        req.csrfToken = row.csrf_token;
        for (const k of ['password_hash', 'csrf_token', 'last_seen_at', 'session_created_at']) delete row[k];
        req.user = row;
        req.sessionToken = token;
      } else {
        destroySession(token);
        clearSessionCookie(res);
        if (row.active) {
          res.append('Set-Cookie', 'flash=info|auth.sessionExpired; Path=/; Max-Age=60; SameSite=Lax; HttpOnly');
          req.sessionJustExpired = true;
        }
      }
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
    // A form sent after the sign-in ended for inactivity: say so plainly, and how to recover.
    if (req.sessionJustExpired) {
      return res.status(403).render('error', { title: res.locals.t('idle.endedTitle'), message: res.locals.t('idle.formNotSaved') });
    }
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

// Sign-in rate limits live in login-guard.js. pruneAttempts is kept for the server's timer.
const guard = require('./login-guard');
const pruneAttempts = (now) => guard.prune(now);

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, destroySession, setSessionCookie, clearSessionCookie,
  loadSession, csrfProtect, ensureAnonCsrf, requireLogin, requireRole, forbidden, notFound,
  pruneAttempts, cookieOptions,
  parseDbTime, dbTime, idleLimitMs, maxLifetimeMs,
};
