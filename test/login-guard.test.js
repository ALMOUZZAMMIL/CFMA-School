'use strict';
// Sign-in protection for a school where everyone shares one internet address.
// Different addresses are simulated with X-Forwarded-For (TRUST_PROXY=1, as behind Caddy).
process.env.TRUST_PROXY = '1';
const test = require('node:test');
const assert = require('node:assert');
const { seededDb, startApp, Client } = require('./helpers');
const guard = require('../src/login-guard');

const { file } = seededDb();
let ctx;
test.before(async () => { ctx = await startApp(file); });
test.after(() => ctx.server.close());
test.beforeEach(() => guard.counters.clear());

const SCHOOL = '41.202.10.1'; // the school's single public address
const at = (ip) => new Client(ctx.base, { 'x-forwarded-for': ip });
async function tryLogin(c, username, password) {
  await c.get('/login');
  return (await c.post('/login', { username, password, next: '/' })).status;
}
// A staff member who has signed in on this browser before (a "known device").
async function knownDevice(ip, username) {
  const c = at(ip);
  assert.strictEqual(await tryLogin(c, username, 'demo-password'), 302);
  assert.ok(c.cookies.dev, 'device cookie set');
  await c.post('/logout', {});
  delete c.cookies.sid;
  return c;
}

test('one pupil spraying many accounts from the school address does not lock staff out on their usual devices', async () => {
  const teacher = await knownDevice(SCHOOL, 'demo.prof.maths');
  const admin = await knownDevice(SCHOOL, 'demo.admin');
  const pupil = at(SCHOOL);
  for (let i = 0; i < 110; i++) await tryLogin(pupil, `guess${i}`, 'wrong');
  // The address is now flooded: unknown devices are stopped...
  assert.strictEqual(await tryLogin(pupil, 'guess-new', 'wrong'), 429);
  assert.strictEqual(await tryLogin(at(SCHOOL), 'demo.prof.lettres', 'demo-password'), 429, 'first sign-in on a new device waits (documented)');
  // ...but staff on devices they have used before still sign in normally.
  assert.strictEqual(await tryLogin(teacher, 'demo.prof.maths', 'demo-password'), 302);
  assert.strictEqual(await tryLogin(admin, 'demo.admin', 'demo-password'), 302);
  // People elsewhere are unaffected.
  assert.strictEqual(await tryLogin(at('102.244.1.9'), 'demo.parent', 'demo-password'), 302);
});

test("a pupil guessing one teacher's password from the school address cannot lock that teacher out", async () => {
  const teacher = await knownDevice(SCHOOL, 'demo.prof.maths');
  const pupil = at(SCHOOL);
  for (let i = 0; i < 30; i++) await tryLogin(pupil, 'demo.prof.maths', `guess${i}`);
  assert.strictEqual(await tryLogin(pupil, 'demo.prof.maths', 'demo-password'), 429, 'the guesser is stopped, even with the right password');
  // Only 8 guesses were counted for that address and account; the account stays open.
  assert.strictEqual(await tryLogin(teacher, 'demo.prof.maths', 'demo-password'), 302);
  assert.strictEqual(await tryLogin(at('102.244.1.10'), 'demo.prof.maths', 'demo-password'), 302);
});

test('repeated attacks on one account from many addresses close it to unknown devices only', async () => {
  const owner = await knownDevice('102.244.2.2', 'demo.prof.tech');
  for (let i = 0; i < 25; i++) await tryLogin(at(`198.51.100.${i}`), 'demo.prof.tech', `guess${i}`);
  // 20 failures spread over addresses: further guesses from new addresses are refused.
  assert.strictEqual(await tryLogin(at('198.51.100.200'), 'demo.prof.tech', 'demo-password'), 429);
  // The same account typed as its email is the same account.
  ctx.db.get().prepare("UPDATE users SET email = 'tech@example.test' WHERE username = 'demo.prof.tech'").run();
  assert.strictEqual(await tryLogin(at('198.51.100.201'), 'tech@example.test', 'x'), 429);
  // The owner's known device still works.
  assert.strictEqual(await tryLogin(owner, 'demo.prof.tech', 'demo-password'), 302);
  // Other accounts are untouched.
  assert.strictEqual(await tryLogin(at('198.51.100.202'), 'demo.teacher.eng', 'demo-password'), 302);
});

test('a known device is not a free pass: 8 wrong passwords on it and it is treated as unknown', async () => {
  const dev = await knownDevice('102.244.3.3', 'demo.intendant');
  for (let i = 0; i < 8; i++) assert.strictEqual(await tryLogin(dev, 'demo.intendant', `bad${i}`), 401);
  // Address+account limit reached as well; refused.
  assert.strictEqual(await tryLogin(dev, 'demo.intendant', 'demo-password'), 429);
  // A device cookie for one account does not help with another account.
  const stolen = at('102.244.3.4');
  stolen.cookies.dev = dev.cookies.dev;
  for (let i = 0; i < 25; i++) await tryLogin(at(`203.0.113.${i}`), 'demo.eleve', `guess${i}`);
  assert.strictEqual(await tryLogin(stolen, 'demo.eleve', 'demo-password'), 429);
});

test('device tokens are stored hashed, expire, and a forged token is ignored', async () => {
  const dev = await knownDevice('102.244.4.4', 'demo.parent.en');
  const tok = dev.cookies.dev.split('.')[0];
  const rows = ctx.db.get().prepare('SELECT token_hash FROM device_tokens').all().map((r) => r.token_hash);
  assert.ok(!rows.includes(tok), 'raw token never stored');
  const forged = at('102.244.4.5');
  forged.cookies.dev = 'A'.repeat(32);
  const user = ctx.db.get().prepare("SELECT * FROM users WHERE username = 'demo.parent.en'").get();
  assert.strictEqual(guard.knownDevice(forged.cookies.dev, user), null);
  assert.ok(guard.knownDevice(dev.cookies.dev, user));
  assert.strictEqual(guard.knownDevice(dev.cookies.dev, user, Date.now() + 91 * 86400000), null, 'expires after 90 days');
  assert.ok(guard.purgeExpiredDevices(Date.now() + 91 * 86400000) >= 1);
});
