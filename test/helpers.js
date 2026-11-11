'use strict';
// Shared test setup: a temporary database loaded with the demo data, the app on a random
// port, and a small cookie-keeping HTTP client.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function seededDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-test-'));
  const file = path.join(tmp, 'test.db');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], { env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: file }, stdio: 'ignore' });
  return { tmp, file };
}

function startApp(file) {
  process.env.DATABASE_FILE = file;
  const db = require('../src/db');
  db.open(file);
  const { createApp } = require('../src/app');
  const app = createApp();
  const server = app.listen(0);
  return new Promise((resolve) => server.once('listening', () => resolve({ db, app, server, base: `http://127.0.0.1:${server.address().port}` })));
}

class Client {
  constructor(base, headers = {}) { this.base = base; this.cookies = {}; this.extra = headers; }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  header() { return Object.entries(this.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; '); }
  async get(p) {
    const res = await fetch(this.base + p, { headers: { ...this.extra, cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, text, location: res.headers.get('location'), headers: res.headers };
  }
  async post(p, data = {}, { csrf = true } = {}) {
    const body = new URLSearchParams(csrf ? { _csrf: this.csrf, ...data } : data);
    const res = await fetch(this.base + p, { method: 'POST', body, headers: { ...this.extra, cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  async login(username, password = 'demo-password') {
    await this.get('/login');
    const r = await this.post('/login', { username, password, next: '/' });
    if (r.status !== 302) throw new Error(`login failed for ${username}: ${r.status}`);
    await this.get('/');
    return this;
  }
}

// Every route registered on the app, as [METHOD, path pattern].
function listRoutes(app) {
  const out = [];
  (function walk(stack) {
    for (const l of stack) {
      // Array paths are router-level role guards, not pages, so they are skipped.
      if (l.route && typeof l.route.path !== 'string') continue;
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push([m.toUpperCase(), l.route.path]);
      else if (l.handle && l.handle.stack) walk(l.handle.stack);
    }
  })(app._router.stack);
  return out;
}

module.exports = { ROOT, seededDb, startApp, Client, listRoutes };
