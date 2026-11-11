'use strict';
// Regression tests for authorization: every route, every role. Written before the Phase A
// refactoring (router-level guards, admin.js split) so that any change in who can reach what
// shows up here.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { seededDb, startApp, Client, listRoutes } = require('./helpers');

let ctx; let dbInfo; let routes;
before(async () => { dbInfo = seededDb(); ctx = await startApp(dbInfo.file); routes = listRoutes(ctx.app); });
after(() => { ctx.server.close(); fs.rmSync(dbInfo.tmp, { recursive: true, force: true }); });

const q = (sql, ...a) => ctx.db.get().prepare(sql).get(...a);
const PUBLIC = new Set(['/brand.css', '/login', '/logout', '/lang', '/register', '/forgot-password', '/healthz', '/session/status']);

// GET pages each non-admin role may open (pattern level; record-level checks are in app.test.js).
const ALL_SIGNED_IN = ['/', '/account/password', '/notifications'];
const GET_ALLOWED = {
  teacher: [...ALL_SIGNED_IN, '/teaching', '/timetable', '/sessions/:id', '/sessions/:id/edit', '/sessions', '/progress', '/progress/:aid',
    '/attendance', '/attendance/:classId', '/attendance/:classId/history', '/attendance/:classId/print', '/attendance/:classId/export.csv',
    '/announcements', '/announcements/:id', '/students/:id', '/plans', '/plans/:id', '/reports/hours', '/reports/absences', '/sessions/new'],
  parent: [...ALL_SIGNED_IN, '/timetable', '/announcements', '/announcements/:id', '/students/:id'],
  student: [...ALL_SIGNED_IN, '/timetable', '/announcements', '/announcements/:id', '/students/:id', '/me'],
  bursar: [...ALL_SIGNED_IN],
};
// POST actions each non-admin role may use.
const POST_ALLOWED = {
  teacher: ['/account/password', '/notifications/read', '/sessions', '/sessions/:id', '/progress/:aid', '/attendance/:classId', '/session/keepalive'],
  parent: ['/account/password', '/notifications/read', '/session/keepalive'],
  student: ['/account/password', '/notifications/read', '/session/keepalive'],
  bursar: ['/account/password', '/notifications/read', '/session/keepalive'],
};
const USERS = { teacher: 'demo.prof.maths', parent: 'demo.parent', student: 'demo.eleve', bursar: 'demo.intendant' };
const fill = (p) => p.replace(/:\w+/g, '1');

test('the route list is complete enough to be meaningful', () => {
  assert.ok(routes.length >= 90, `found ${routes.length} routes`);
  assert.ok(routes.some(([m, p]) => m === 'POST' && p === '/admin/settings'));
});

for (const role of Object.keys(USERS)) {
  test(`${role}: every page outside the allowed list is refused`, async () => {
    const c = await new Client(ctx.base).login(USERS[role]);
    for (const [m, p] of routes) {
      if (m !== 'GET' || PUBLIC.has(p) || GET_ALLOWED[role].includes(p)) continue;
      const r = await c.get(fill(p));
      assert.ok([403, 404].includes(r.status) || (r.status === 302 && !/^\/admin/.test(r.location || '')),
        `${role} GET ${p} gave ${r.status} ${r.location || ''}`);
      assert.notStrictEqual(r.status, 200, `${role} must not open ${p}`);
    }
  });

  test(`${role}: every action outside the allowed list is refused and changes nothing`, async () => {
    const c = await new Client(ctx.base).login(USERS[role]);
    const before = q('SELECT COUNT(*) n FROM audit_log').n;
    const settings = JSON.stringify(ctx.db.getSettings());
    for (const [m, p] of routes) {
      if (m !== 'POST' || PUBLIC.has(p) || POST_ALLOWED[role].includes(p)) continue;
      const r = await c.post(fill(p), { name: 'x', full_name: 'Escalation Test', username: 'escalated', role: 'admin', school_name: 'Hacked', title_fr: 'x', title_en: 'x', body_fr: 'x', body_en: 'x' });
      assert.ok([403, 404].includes(r.status), `${role} POST ${p} gave ${r.status}`);
    }
    assert.strictEqual(q('SELECT COUNT(*) n FROM audit_log').n, before, 'no change was recorded');
    assert.strictEqual(JSON.stringify(ctx.db.getSettings()), settings);
    assert.strictEqual(q("SELECT COUNT(*) n FROM users WHERE username = 'escalated'").n, 0);
  });
}

test('signed-out visitors are sent to sign in for every non-public page', async () => {
  const c = new Client(ctx.base);
  for (const [m, p] of routes) {
    if (m !== 'GET' || PUBLIC.has(p) || p === '/') continue;
    const r = await c.get(fill(p));
    assert.strictEqual(r.status, 302, `GET ${p}`);
    assert.match(r.location, /^\/login/);
  }
});

test('a teacher cannot see a student they taught only in a previous school year', async () => {
  const d = ctx.db.get();
  const teacher = q("SELECT id FROM users WHERE username = 'demo.prof.maths'");
  const cur = q('SELECT * FROM academic_years WHERE is_current = 1');
  // A student who is not in any class this teacher teaches this year.
  const st = q(`SELECT s.id FROM students s WHERE NOT EXISTS (
      SELECT 1 FROM enrollments e JOIN teaching_assignments ta ON ta.class_id = e.class_id WHERE e.student_id = s.id AND ta.teacher_id = ?) LIMIT 1`, teacher.id);
  const c = await new Client(ctx.base).login('demo.prof.maths');
  assert.strictEqual((await c.get(`/students/${st.id}`)).status, 404, 'not visible before');
  // Last year, this teacher taught that student.
  const y = d.prepare("INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES ('2019-2020 (test)', '2019-09-01', '2020-06-30', 0)").run();
  const section = q('SELECT id FROM sections LIMIT 1').id;
  const subject = q('SELECT id FROM subjects LIMIT 1').id;
  const cls = d.prepare("INSERT INTO classes (year_id, section_id, level, name) VALUES (?, ?, 'Old', 'Old class (test)')").run(y.lastInsertRowid, section);
  d.prepare('INSERT INTO enrollments (student_id, class_id) VALUES (?, ?)').run(st.id, cls.lastInsertRowid);
  d.prepare('INSERT INTO teaching_assignments (class_id, subject_id, teacher_id) VALUES (?, ?, ?)').run(cls.lastInsertRowid, subject, teacher.id);
  assert.ok(cur, 'a current year exists');
  assert.strictEqual((await c.get(`/students/${st.id}`)).status, 404, 'still not visible: that class belongs to a past year');
  // Nor can they open that old class's register, which lists the students.
  assert.strictEqual((await c.get(`/attendance/${cls.lastInsertRowid}`)).status, 404);
});
