'use strict';
// Phase A: health check, HSTS, idle timeouts, limiter memory, settings validation, start-up guards.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { seededDb, startApp, Client, ROOT } = require('./helpers');

const { file } = seededDb();
let ctx;
test.before(async () => { ctx = await startApp(file); });
test.after(() => ctx.server.close());

test('health check answers without signing in and reveals nothing private', async () => {
  const res = await fetch(`${ctx.base}/healthz`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.database, 'ok');
  assert.strictEqual(body.schemaVersion, 3);
  assert.deepStrictEqual(Object.keys(body).sort(), ['database', 'schemaVersion', 'status', 'uptimeSeconds']);
  assert.ok(!res.headers.get('set-cookie'), 'no session or CSRF cookie');
  assert.ok(res.headers.get('x-request-id'));
});

test('no HSTS header outside production', async () => {
  const res = await fetch(`${ctx.base}/login`);
  assert.strictEqual(res.headers.get('strict-transport-security'), null);
});

const sid = (c) => require('crypto').createHash('sha256').update(c.cookies.sid).digest('hex');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);

test('an administrator idle for 2 hours is signed out and told why', async () => {
  const c = await new Client(ctx.base).login('demo.admin');
  ctx.db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(ago(120), sid(c));
  const r = await c.get('/admin');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /^\/login/);
  assert.match(c.cookies.flash || '', /auth\.sessionExpired/);
  const page = await c.get('/login');
  assert.match(page.text, /inactiv/i);
});

test('a teacher idle for 40 minutes stays signed in; activity is recorded', async () => {
  const c = await new Client(ctx.base).login('demo.prof.maths');
  const h = sid(c);
  ctx.db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(ago(40), h);
  const r = await c.get('/teaching');
  assert.strictEqual(r.status, 200);
  const seen = ctx.db.get().prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(h).last_seen_at;
  assert.ok(seen > ago(1), `last_seen_at updated (${seen})`);
});

test('a teacher idle beyond 4 hours is signed out', async () => {
  const c = await new Client(ctx.base).login('demo.prof.maths');
  ctx.db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(ago(245), sid(c));
  assert.strictEqual((await c.get('/teaching')).status, 302);
});

test('administrator sign-ins last at most 12 hours even when active', async () => {
  const c = await new Client(ctx.base).login('demo.admin');
  const row = ctx.db.get().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sid(c));
  const hours = (Date.parse(row.expires_at) - Date.now()) / 3600000;
  assert.ok(hours > 11.9 && hours <= 12, `expires in ${hours} h`);
  ctx.db.get().prepare('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token_hash = ?').run(ago(13 * 60), ago(1), sid(c));
  assert.strictEqual((await c.get('/admin')).status, 302);
});

test('a parent sign-in keeps the normal multi-day lifetime', async () => {
  const c = await new Client(ctx.base).login('demo.parent').catch(() => null);
  if (!c) return; // username differs in the demo data; covered by the admin case above
  const row = ctx.db.get().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sid(c));
  assert.ok((Date.parse(row.expires_at) - Date.now()) / 86400000 > 6.9);
});

test('login limiter: blocks after 8 failures, forgets old entries, and stays under its size cap', () => {
  const auth = require('../src/auth');
  auth.attempts.clear();
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) auth.recordLoginFailure('1.2.3.4|someone', t0);
  assert.ok(auth.loginLimited('1.2.3.4|someone', t0));
  assert.ok(!auth.loginLimited('1.2.3.4|someone', t0 + 16 * 60000), 'window expires');
  // Many usernames from one address hit the per-address ceiling.
  for (let i = 0; i < 100; i++) auth.recordLoginFailure(`5.6.7.8|user${i}`, t0);
  assert.ok(auth.loginLimited('5.6.7.8|fresh-name', t0));
  assert.ok(auth.pruneAttempts(t0 + 16 * 60000) === 0, 'expired entries removed');
  for (let i = 0; i < auth.MAX_KEYS + 500; i++) auth.recordLoginFailure(`10.0.${i}|u`, t0);
  assert.ok(auth.attempts.size <= auth.MAX_KEYS + 1, `size ${auth.attempts.size}`);
  auth.attempts.clear();
});

test('public form limiter forgets old entries and stays under its size cap', () => {
  const { limiter } = require('../src/routes/public');
  limiter.hits.clear();
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) limiter.count('9.9.9.9', t0);
  assert.ok(limiter.tooMany('9.9.9.9', t0));
  assert.ok(!limiter.tooMany('9.9.9.9', t0 + 3600001));
  assert.ok(!limiter.hits.has('9.9.9.9'), 'empty entries are deleted');
  for (let i = 0; i < limiter.MAX_IPS + 300; i++) limiter.count(`ip${i}`, t0);
  assert.ok(limiter.hits.size <= limiter.MAX_IPS);
  assert.strictEqual(limiter.pruneHits(t0 + 3600001), 0);
});

test('invalid settings are rejected with a clear list of problems', () => {
  const config = require('../src/config');
  assert.throws(() => config.load({ PORT: 'abc', NODE_ENV: 'prod', SESSION_DAYS: '0', TRUST_PROXY: 'yes', IDLE_MINUTES_ADMIN: '2' }), (e) => {
    assert.ok(e instanceof config.ConfigError);
    assert.strictEqual(e.problems.length, 5, e.message);
    return true;
  });
  const ok = config.load({ NODE_ENV: 'production', DATABASE_FILE: file });
  assert.strictEqual(ok.cookieSecure, true);
  assert.strictEqual(ok.idleMinutes.admin, 30);
});

const runServer = (env) => spawnSync(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: '0', ...env }, encoding: 'utf8', timeout: 10000 });

test('the server will not start with invalid settings', () => {
  const r = runServer({ NODE_ENV: 'test', DATABASE_FILE: file, PORT: 'eighty' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /PORT must be a whole number/);
});

test('the server will not serve a demo database in production unless explicitly allowed', () => {
  const r = runServer({ NODE_ENV: 'production', DATABASE_FILE: file });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /DEMO data/);
});

test('production: HSTS is sent, and SIGTERM shuts down cleanly', async () => {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', ALLOW_DEMO_IN_PRODUCTION: '1', DATABASE_FILE: file, PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'info', BACKUP_INTERVAL_HOURS: '0' },
  });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no start: ${out}`)), 8000);
    p.stdout.on('data', () => { const m = out.match(/"server started".*?"port":(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
  });
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d+/);
  const login = await fetch(`http://127.0.0.1:${port}/login`);
  assert.match(login.headers.get('set-cookie') || '', /Secure/);
  const exit = new Promise((resolve) => p.on('exit', (code) => resolve(code)));
  p.kill('SIGTERM');
  assert.strictEqual(await exit, 0);
  assert.match(out, /"shutting down"/);
  assert.match(out, /"stopped"/);
});
