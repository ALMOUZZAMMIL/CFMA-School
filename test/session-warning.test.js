'use strict';
// Warning before an idle sign-out, and a clear message when a form arrives after one.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { seededDb, startApp, Client } = require('./helpers');

const { file } = seededDb();
let ctx;
test.before(async () => { ctx = await startApp(file); });
test.after(() => ctx.server.close());

const hashOf = (c) => crypto.createHash('sha256').update(c.cookies.sid).digest('hex');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);
const json = async (c, p, opts = {}) => {
  const res = await fetch(ctx.base + p, { ...opts, headers: { cookie: c.header(), ...(opts.headers || {}) }, redirect: 'manual' });
  return { status: res.status, body: res.status < 300 || res.status === 401 ? await res.json() : await res.text(), cache: res.headers.get('cache-control') };
};

test('status: signed out answers signedIn=false and reveals nothing else', async () => {
  const r = await json(new Client(ctx.base), '/session/status');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { signedIn: false });
  assert.strictEqual(r.cache, 'no-store');
});

test('status: reports the time left and does NOT count as activity', async () => {
  const c = await new Client(ctx.base).login('demo.admin');
  const set = ago(20);
  ctx.db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(set, hashOf(c));
  const r = await json(c, '/session/status');
  assert.strictEqual(r.body.signedIn, true);
  assert.ok(r.body.remainingSeconds > 500 && r.body.remainingSeconds <= 600, `remaining ${r.body.remainingSeconds}`);
  const seen = ctx.db.get().prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hashOf(c)).last_seen_at;
  assert.strictEqual(seen, set, 'last activity unchanged');
});

test('keep-alive: needs the form token, then resets the idle clock', async () => {
  const c = await new Client(ctx.base).login('demo.admin');
  ctx.db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(ago(28), hashOf(c));
  const page = await c.get('/');
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.strictEqual((await json(c, '/session/keepalive', { method: 'POST' })).status, 403, 'refused without the token');
  const r = await json(c, '/session/keepalive', { method: 'POST', headers: { 'x-csrf-token': token } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.remainingSeconds, 1800);
  const seen = ctx.db.get().prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').get(hashOf(c)).last_seen_at;
  assert.ok(seen >= ago(1));
});

test('the warning box is on signed-in pages only', async () => {
  const c = await new Client(ctx.base).login('demo.prof.maths');
  assert.match((await c.get('/teaching')).text, /id="session-warning"[^>]*data-user="\d+"/);
  assert.doesNotMatch((await new Client(ctx.base).get('/login')).text, /session-warning/);
});

test('a form sent after an idle sign-out gets a clear "not saved" message, and nothing is written', async () => {
  const c = await new Client(ctx.base).login('demo.prof.maths');
  const cls = ctx.db.get().prepare(`SELECT ta.class_id FROM teaching_assignments ta JOIN users u ON u.id = ta.teacher_id WHERE u.username = 'demo.prof.maths' LIMIT 1`).get().class_id;
  await c.get(`/attendance/${cls}`);
  const before = ctx.db.get().prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  ctx.db.get().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(ago(300), hashOf(c));
  const r = await c.post(`/attendance/${cls}`, { date: '2026-11-10' });
  assert.strictEqual(r.status, 403);
  assert.match(r.text, /Back|Retour/);
  assert.strictEqual(ctx.db.get().prepare('SELECT COUNT(*) n FROM audit_log').get().n, before);
});
