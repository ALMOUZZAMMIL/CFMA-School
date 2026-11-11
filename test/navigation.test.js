'use strict';
// The redesigned menu (sidebar, phone tab bar) must only list pages the role can open,
// and must not hide pages the old menu offered.
const test = require('node:test');
const assert = require('node:assert');
const { seededDb, startApp, Client } = require('./helpers');
const nav = require('../src/nav');

const { file } = seededDb();
let ctx;
test.before(async () => { ctx = await startApp(file); });
test.after(() => ctx.server.close());

const USERS = { admin: 'demo.admin', teacher: 'demo.prof.maths', parent: 'demo.parent', student: 'demo.eleve', bursar: 'demo.intendant' };

function block(html, open, close) {
  const i = html.indexOf(open);
  if (i < 0) return '';
  return html.slice(i, html.indexOf(close, i));
}
const hrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

for (const [role, username] of Object.entries(USERS)) {
  test(`${role}: every menu and tab-bar link opens a page`, async () => {
    const c = await new Client(ctx.base).login(username);
    const home = await c.get('/');
    assert.strictEqual(home.status, 200);
    const menu = hrefs(block(home.text, '<nav id="menu"', '</nav>'));
    const tabs = hrefs(block(home.text, '<nav class="tabbar"', '</nav>'));
    assert.ok(menu.length >= 1, 'menu is shown');
    for (const href of new Set([...menu, ...tabs])) {
      if (href === '#' || href === '#menu') continue;
      const r = await c.get(href);
      assert.ok(r.status === 200 || (r.status === 302 && !/\/login/.test(r.location || '')), `${role} ${href} -> ${r.status} ${r.location || ''}`);
    }
    assert.ok(tabs.length <= 4, 'at most four tabs');
  });
}

test('only admins see administration links; bursar sees home only', async () => {
  for (const role of ['teacher', 'parent', 'student', 'bursar']) {
    const c = await new Client(ctx.base).login(USERS[role]);
    const html = (await c.get('/')).text;
    assert.doesNotMatch(block(html, '<nav id="menu"', '</nav>'), /href="\/admin/, `${role} sees no admin link`);
  }
  const b = await new Client(ctx.base).login(USERS.bursar);
  assert.deepStrictEqual(hrefs(block((await b.get('/')).text, '<nav id="menu"', '</nav>')).filter((h) => h !== '#' && h !== '/'), []);
});

test('the menu keeps every destination the previous menu offered', () => {
  const ids = (role) => nav.build(role, '/').groups.flatMap((g) => g.items.map((i) => i.href));
  const previous = {
    admin: ['/', '/teaching', '/attendance', '/progress', '/plans', '/reports/hours', '/announcements'],
    teacher: ['/', '/teaching', '/attendance', '/progress', '/plans', '/reports/hours', '/timetable', '/announcements'],
    parent: ['/', '/timetable', '/announcements', '/notifications'],
    student: ['/', '/timetable', '/me', '/announcements'],
    bursar: ['/'],
  };
  for (const [role, list] of Object.entries(previous)) for (const href of list) assert.ok(ids(role).includes(href), `${role} still has ${href}`);
  // The admin hub's destinations are all in the admin sidebar.
  for (const href of ['/admin/structure', '/admin/requests', '/admin/users', '/admin/students', '/admin/timetable', '/admin/settings', '/admin/outbox', '/admin/audit']) {
    assert.ok(ids('admin').includes(href), `admin has ${href}`);
  }
});

test('active item follows the page, and the pending-requests count is shown', async () => {
  const c = await new Client(ctx.base).login(USERS.admin);
  ctx.db.get().prepare("INSERT INTO access_requests (kind, full_name, role_requested, status) VALUES ('account', 'Test DEMO', 'parent', 'pending')").run();
  const html = (await c.get('/admin/students')).text;
  assert.match(html, /class="sb-item on" href="\/admin\/students" aria-current="page"/);
  assert.match(block(html, '<nav id="menu"', '</nav>'), /href="\/admin\/requests">.*?<span class="count">\d+/s);
});
