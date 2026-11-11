'use strict';
// Protection against password guessing, designed for a school where many people share one
// internet address. Every limit counts failed sign-ins within a 15-minute window:
//
//   1. address + account   8 failures  -> that address cannot try that account (unknown devices)
//   2. account             20 failures -> the account is closed to unknown devices (guessing
//                                         spread over many addresses)
//   3. address             100 failures -> that address cannot try any account from an
//                                          unknown device (one machine trying many accounts)
//   4. known device         8 failures  -> that device is treated as unknown again
//
// A "known device" is a browser where this account has already signed in successfully (see
// migration 4). It is judged only on limit 4, its own failures, so a pupil hammering the school's shared
// address, or someone guessing one teacher's password from elsewhere, cannot stop staff
// from signing in on their usual devices. The password is always checked.
const crypto = require('crypto');
const db = require('./db');

const WINDOW_MS = 15 * 60000;
const LIMITS = { pair: 8, account: 20, ip: 100, device: 8 };
const MAX_KEYS = 10000;
const DEVICE_COOKIE = 'dev';
const DEVICE_DAYS = 90;
const MAX_DEVICE_TOKENS = 5; // per browser (e.g. a shared staff-room computer)

const counters = new Map();

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function count(k, now) {
  const rec = counters.get(k);
  return rec && now - rec.first <= WINDOW_MS ? rec.count : 0;
}
function bump(k, now) {
  const rec = counters.get(k);
  if (!rec || now - rec.first > WINDOW_MS) {
    counters.delete(k);
    counters.set(k, { first: now, count: 1 });
  } else rec.count++;
}

// Removes expired entries; if still too many, drops the oldest (Map keeps insertion order).
function prune(now = Date.now()) {
  for (const [k, rec] of counters) if (now - rec.first > WINDOW_MS) counters.delete(k);
  while (counters.size > MAX_KEYS) counters.delete(counters.keys().next().value);
  return counters.size;
}

const keys = ({ ip, account, device }) => ({
  pair: `p:${ip}|${account}`, account: `a:${account}`, ip: `i:${ip}`, device: device ? `d:${device}` : null,
});

// The account key: the user's id when the name matches an account (so username and email
// share one counter), otherwise the name as typed.
function accountKey(user, typed) { return user ? `u${user.id}` : `n:${String(typed).toLowerCase()}`; }

// Hash of a valid device token in this browser for this user, or null.
function knownDevice(cookieValue, user, now = Date.now()) {
  if (!user || !cookieValue) return null;
  const nowIso = new Date(now).toISOString();
  const stmt = db.get().prepare('SELECT 1 FROM device_tokens WHERE token_hash = ? AND user_id = ? AND expires_at > ?');
  for (const tok of String(cookieValue).split('.').slice(0, MAX_DEVICE_TOKENS)) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(tok)) continue;
    const h = sha256(tok);
    if (stmt.get(h, user.id, nowIso)) return h;
  }
  return null;
}

// Returns which limit blocks this attempt, or null if it may go ahead.
function blocked({ ip, account, device }, now = Date.now()) {
  const k = keys({ ip, account, device });
  // A known device of this account is judged only on its own failures, so failures by others
  // on the same shared address (even against the same account) do not block it.
  if (device && count(k.device, now) < LIMITS.device) return null;
  if (count(k.pair, now) >= LIMITS.pair) return 'pair';
  if (count(k.account, now) >= LIMITS.account) return 'account';
  if (count(k.ip, now) >= LIMITS.ip) return 'ip';
  return null;
}

function recordFailure({ ip, account, device }, now = Date.now()) {
  const k = keys({ ip, account, device });
  bump(k.pair, now);
  if (device && count(k.device, now) < LIMITS.device) bump(k.device, now);
  else { bump(k.account, now); bump(k.ip, now); }
  if (counters.size > MAX_KEYS) prune(now);
}

function recordSuccess({ ip, account }) {
  counters.delete(keys({ ip, account }).pair);
}

// After a successful sign-in: make sure this browser holds a device token for this user.
// Returns the new cookie value (existing tokens kept, newest first, at most MAX_DEVICE_TOKENS).
function rememberDevice(cookieValue, user, now = Date.now()) {
  const existing = String(cookieValue || '').split('.').filter((t) => /^[A-Za-z0-9_-]{20,64}$/.test(t));
  const expires = new Date(now + DEVICE_DAYS * 86400000).toISOString();
  const mine = knownDevice(existing.join('.'), user, now);
  if (mine) {
    db.get().prepare('UPDATE device_tokens SET expires_at = ? WHERE token_hash = ?').run(expires, mine);
    return existing.slice(0, MAX_DEVICE_TOKENS).join('.');
  }
  const tok = crypto.randomBytes(24).toString('base64url');
  db.get().prepare('INSERT INTO device_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(tok), user.id, expires);
  return [tok, ...existing].slice(0, MAX_DEVICE_TOKENS).join('.');
}

function purgeExpiredDevices(now = Date.now()) {
  return db.get().prepare('DELETE FROM device_tokens WHERE expires_at < ?').run(new Date(now).toISOString()).changes;
}

module.exports = {
  WINDOW_MS, LIMITS, MAX_KEYS, DEVICE_COOKIE, DEVICE_DAYS, counters,
  accountKey, knownDevice, blocked, recordFailure, recordSuccess, rememberDevice, prune, purgeExpiredDevices,
};
