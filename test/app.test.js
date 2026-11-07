'use strict';
// End-to-end tests against a temporary database loaded with the demo data.
// Focus: server-side permissions, CSRF, duplicate protection and change history.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-test-'));
const dbFile = path.join(tmp, 'test.db');
process.env.DATABASE_FILE = dbFile;
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { ...process.env, DATABASE_FILE: dbFile }, stdio: 'ignore' });

const db = require('../src/db');
db.open(dbFile);
const { createApp } = require('../src/app');

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

class Client {
  constructor() { this.cookies = {}; }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  header() { return Object.entries(this.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; '); }
  async get(p) {
    const res = await fetch(base + p, { headers: { cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, text, location: res.headers.get('location') };
  }
  async post(p, data, { csrf = true } = {}) {
    const body = new URLSearchParams(csrf ? { _csrf: this.csrf, ...data } : data);
    const res = await fetch(base + p, { method: 'POST', body, headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
}

async function loginAs(username) {
  const c = new Client();
  await c.get('/login');
  const r = await c.post('/login', { username, password: 'demo-password', next: '/' });
  assert.strictEqual(r.status, 302, `login ${username}`);
  await c.get('/');
  return c;
}

const q = (sql, ...a) => db.get().prepare(sql).get(...a);

test('wrong password is rejected and does not reveal which part was wrong', async () => {
  const c = new Client();
  await c.get('/login');
  const r = await c.post('/login', { username: 'demo.admin', password: 'nope' });
  assert.strictEqual(r.status, 401);
  const r2 = await c.post('/login', { username: 'nobody', password: 'nope' });
  assert.strictEqual(r2.status, 401);
});

test('pages require login', async () => {
  const r = await new Client().get('/attendance');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /^\/login/);
});

test('POST without CSRF token is refused', async () => {
  const c = await loginAs('demo.admin');
  const r = await c.post('/admin/settings', { school_name: 'Hacked' }, { csrf: false });
  assert.strictEqual(r.status, 403);
  assert.notStrictEqual(db.getSettings().school_name, 'Hacked');
});

test('a parent cannot open another family\'s child by changing the URL', async () => {
  const c = await loginAs('demo.parent');
  const parent = q("SELECT id FROM users WHERE username = 'demo.parent'");
  const mine = q('SELECT student_id FROM guardians WHERE parent_user_id = ? LIMIT 1', parent.id).student_id;
  const other = q('SELECT id FROM students WHERE id NOT IN (SELECT student_id FROM guardians WHERE parent_user_id = ?) LIMIT 1', parent.id).id;
  assert.strictEqual((await c.get(`/students/${mine}`)).status, 200);
  assert.strictEqual((await c.get(`/students/${other}`)).status, 404);
  assert.strictEqual((await c.get(`/timetable?student=${other}`)).status, 404);
});

test('a student can only see their own record', async () => {
  const c = await loginAs('demo.eleve');
  const own = q("SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.username = 'demo.eleve'").id;
  assert.strictEqual((await c.get(`/students/${own}`)).status, 200);
  assert.strictEqual((await c.get(`/students/${own + 1}`)).status, 404);
  assert.strictEqual((await c.get('/attendance')).status, 403);
  assert.strictEqual((await c.get('/admin/users')).status, 403);
});

test('family and finance roles are kept out of staff pages', async () => {
  for (const u of ['demo.parent', 'demo.intendant']) {
    const c = await loginAs(u);
    for (const p of ['/admin', '/admin/students', '/reports/hours', '/progress', '/sessions', '/plans']) {
      assert.strictEqual((await c.get(p)).status, 403, `${u} ${p}`);
    }
  }
  const bursar = await loginAs('demo.intendant');
  const someStudent = q('SELECT id FROM students LIMIT 1').id;
  assert.strictEqual((await bursar.get(`/students/${someStudent}`)).status, 404);
});

test('a teacher cannot record lessons or attendance for classes they do not teach', async () => {
  const c = await loginAs('demo.prof.tech');
  const tech = q("SELECT id FROM users WHERE username = 'demo.prof.tech'").id;
  const otherAssignment = q('SELECT id FROM teaching_assignments WHERE teacher_id != ? LIMIT 1', tech).id;
  const otherClass = q('SELECT id FROM classes WHERE id NOT IN (SELECT class_id FROM teaching_assignments WHERE teacher_id = ?) LIMIT 1', tech).id;
  assert.strictEqual((await c.get(`/progress/${otherAssignment}`)).status, 404);
  assert.strictEqual((await c.get(`/attendance/${otherClass}`)).status, 404);
  const r = await c.post('/sessions', { assignment_id: otherAssignment, date: '2026-10-05', start_time: '08:00', end_time: '09:00', status: 'makeup' });
  assert.strictEqual(r.status, 404);
  const r2 = await c.post(`/attendance/${otherClass}`, { date: '2026-10-05' });
  assert.strictEqual(r2.status, 404);
  const anySession = q('SELECT cs.id FROM class_sessions cs WHERE cs.assignment_id = ?', otherAssignment).id;
  assert.strictEqual((await c.get(`/sessions/${anySession}`)).status, 404);
});

test('recording a lesson twice (double tap) saves it only once', async () => {
  const c = await loginAs('demo.prof.maths');
  const t = q("SELECT id FROM users WHERE username = 'demo.prof.maths'").id;
  const a = q('SELECT id FROM teaching_assignments WHERE teacher_id = ? LIMIT 1', t).id;
  const form = { assignment_id: a, client_uuid: 'test-uuid-1', date: '2026-11-02', start_time: '15:00', end_time: '17:00', status: 'makeup' };
  const r1 = await c.post('/sessions', form);
  const r2 = await c.post('/sessions', form);
  assert.strictEqual(r1.status, 302);
  assert.strictEqual(r2.status, 302);
  assert.strictEqual(q("SELECT COUNT(*) n FROM class_sessions WHERE client_uuid = 'test-uuid-1'").n, 1);
});

test('a missed lesson needs a reason, and corrections keep the old values', async () => {
  const c = await loginAs('demo.prof.maths');
  const t = q("SELECT id FROM users WHERE username = 'demo.prof.maths'").id;
  const s = q("SELECT cs.* FROM class_sessions cs JOIN teaching_assignments ta ON ta.id = cs.assignment_id WHERE ta.teacher_id = ? AND cs.status = 'held' AND cs.slot_id IS NOT NULL LIMIT 1", t);
  // No reason, no change reason: refused.
  const bad = await c.post(`/sessions/${s.id}`, { assignment_id: s.assignment_id, date: s.date, start_time: s.start_time, end_time: s.end_time, status: 'missed' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(q('SELECT status FROM class_sessions WHERE id = ?', s.id).status, 'held');
  const ok = await c.post(`/sessions/${s.id}`, { assignment_id: s.assignment_id, date: s.date, start_time: s.start_time, end_time: s.end_time, status: 'missed', reason: 'Test reason', makeup_status: 'planned', makeup_planned_date: '2026-11-20', change_reason: 'Entered wrongly' });
  assert.strictEqual(ok.status, 302);
  const hist = q("SELECT * FROM audit_log WHERE entity = 'class_session' AND entity_id = ? AND action = 'update'", s.id);
  assert.ok(hist);
  assert.strictEqual(JSON.parse(hist.before_json).status, 'held');
  assert.strictEqual(JSON.parse(hist.after_json).status, 'missed');
  assert.strictEqual(hist.reason, 'Entered wrongly');
});

test('attendance corrections are recorded with who and when, and parents get an in-app notice', async () => {
  const c = await loginAs('demo.prof.maths');
  const parent = q("SELECT id FROM users WHERE username = 'demo.parent'").id;
  const child = q('SELECT g.student_id, e.class_id FROM guardians g JOIN enrollments e ON e.student_id = g.student_id WHERE g.parent_user_id = ? LIMIT 1', parent);
  const date = '2026-11-06';
  await c.get(`/attendance/${child.class_id}?date=${date}`);
  const before = q('SELECT status FROM attendance_records WHERE student_id = ? AND date = ?', child.student_id, date);
  const r = await c.post(`/attendance/${child.class_id}`, { date, [`s_${child.student_id}`]: 'absent' });
  assert.strictEqual(r.status, 302);
  const rec = q('SELECT * FROM attendance_records WHERE student_id = ? AND date = ?', child.student_id, date);
  assert.strictEqual(rec.status, 'absent');
  if (before && before.status !== 'absent') {
    assert.ok(rec.updated_by);
    assert.ok(q("SELECT 1 FROM audit_log WHERE entity = 'attendance' AND entity_id = ? AND action = 'update'", rec.id));
  }
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'absence' AND source LIKE ?", parent, `attendance:${rec.id}:%`));
  // Attendance cannot be entered for future dates.
  const future = await c.post(`/attendance/${child.class_id}`, { date: '2099-01-01', [`s_${child.student_id}`]: 'absent' });
  assert.strictEqual(future.status, 302);
  assert.ok(!q("SELECT 1 FROM attendance_records WHERE date = '2099-01-01'"));
});

test('announcements respect draft status, publish time, audience and class', async () => {
  const admin = await loginAs('demo.admin');
  await admin.get('/announcements/new');
  const otherClass = q("SELECT id FROM classes WHERE name = 'Form 4 A'").id;
  await admin.post('/announcements', { category: 'notice', title_en: 'DRAFT-X', body_en: 'b', audience: 'parent', publish_at: '2026-01-01T08:00', action: 'draft' });
  await admin.post('/announcements', { category: 'notice', title_en: 'FUTURE-X', body_en: 'b', audience: 'parent', publish_at: '2099-01-01T08:00', action: 'publish' });
  await admin.post('/announcements', { category: 'notice', title_en: 'TEACHERS-X', body_en: 'b', audience: 'teacher', publish_at: '2026-01-01T08:00', action: 'publish' });
  await admin.post('/announcements', { category: 'notice', title_en: 'OTHERCLASS-X', body_en: 'b', audience: 'parent', class_id: String(otherClass), publish_at: '2026-01-01T08:00', action: 'publish' });
  await admin.post('/announcements', { category: 'notice', title_en: 'VISIBLE-X', body_en: 'b', audience: 'parent', publish_at: '2026-01-01T08:00', action: 'publish' });
  const parent = await loginAs('demo.parent');
  await parent.post('/lang', { lang: 'en', back: '/announcements' });
  const page = (await parent.get('/announcements')).text;
  assert.match(page, /VISIBLE-X/);
  for (const hidden of ['DRAFT-X', 'FUTURE-X', 'TEACHERS-X', 'OTHERCLASS-X']) assert.doesNotMatch(page, new RegExp(hidden));
  const draftId = q("SELECT id FROM announcements WHERE title_en = 'DRAFT-X'").id;
  assert.strictEqual((await parent.get(`/announcements/${draftId}`)).status, 404);
});

test('prepared SMS messages are never marked as sent', async () => {
  const admin = await loginAs('demo.admin');
  const a = q("SELECT id FROM announcements WHERE status = 'published' AND audience LIKE '%parent%' LIMIT 1").id;
  await admin.get('/announcements/manage');
  await admin.post(`/announcements/${a}/prepare-sms`, {});
  assert.ok(q('SELECT COUNT(*) n FROM message_outbox').n > 0);
  assert.strictEqual(q("SELECT COUNT(*) n FROM message_outbox WHERE status != 'not_sent'").n, 0);
});

test('language preference is saved on the account', async () => {
  const c = await loginAs('demo.prof.maths');
  await c.post('/lang', { lang: 'en', back: '/' });
  assert.strictEqual(q("SELECT language FROM users WHERE username = 'demo.prof.maths'").language, 'en');
  assert.match((await c.get('/')).text, /Welcome/);
  await c.post('/lang', { lang: 'fr', back: '/' });
  assert.match((await c.get('/')).text, /Bienvenue/);
});

test('plan import rejects bad rows without importing anything', async () => {
  const admin = await loginAs('demo.admin');
  const plan = q('SELECT id FROM plans LIMIT 1').id;
  const count = () => q('SELECT COUNT(*) n FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = ?', plan).n;
  const n0 = count();
  await admin.get(`/plans/${plan}`);
  const bad = await admin.post(`/plans/${plan}/import`, { csv: 'Chapitre,Leçon,Date\nCh X,Leçon A,31/02/2027\nCh X,,01/03/2027' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(count(), n0);
  const good = await admin.post(`/plans/${plan}/import`, { csv: 'Chapitre,Leçon,Date,Heures\nCh X,Leçon A,01/03/2027,2\n"Ch X","Leçon B; suite",08/03/2027,"1,5"' });
  assert.strictEqual(good.status, 302);
  assert.strictEqual(count(), n0 + 2);
});

test('teaching hours report adds up', async () => {
  const reports = require('../src/reports');
  const year = db.currentYear();
  const { rows } = reports.hoursSummary({ yearId: year.id, asOf: '2026-10-31' });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.strictEqual(Math.round((r.held + r.makeup) * 10), Math.round(r.delivered * 10));
    assert.ok(r.scheduled >= r.held, 'held hours cannot exceed scheduled (timetabled) hours');
  }
});
