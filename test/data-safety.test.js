'use strict';
// Demo commands must not destroy real data, and a backup must restore to the same data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { seededDb, ROOT } = require('./helpers');

const run = (script, args, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args],
  { env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8' });

function makeReal(file) {
  const d = new Database(file);
  d.prepare("UPDATE settings SET value = '0' WHERE key = 'demo_mode'").run();
  d.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('real.admin', 'x', 'Real Admin', 'admin')").run();
  d.close();
}
const count = (file, sql) => { const d = new Database(file, { readonly: true }); try { return d.prepare(sql).get().n; } finally { d.close(); } };

test('seed refuses to run when NODE_ENV=production, even with --reset', () => {
  const { file } = seededDb();
  const before = count(file, 'SELECT COUNT(*) n FROM users');
  const r = run('seed.js', ['--reset'], { NODE_ENV: 'production', DATABASE_FILE: file });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /production/);
  assert.strictEqual(count(file, 'SELECT COUNT(*) n FROM users'), before);
});

test('seed --reset refuses a database with real accounts and deletes nothing', () => {
  const { file } = seededDb();
  makeReal(file);
  const before = count(file, 'SELECT COUNT(*) n FROM users');
  const r = run('seed.js', ['--reset'], { DATABASE_FILE: file });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /real/);
  assert.strictEqual(count(file, 'SELECT COUNT(*) n FROM users'), before);
  assert.strictEqual(count(file, "SELECT COUNT(*) n FROM users WHERE username = 'real.admin'"), 1);
});

test('seed without --reset refuses a non-empty database', () => {
  const { file } = seededDb();
  const r = run('seed.js', [], { DATABASE_FILE: file });
  assert.strictEqual(r.status, 1);
});

test('seed --reset on a demo database writes a verified backup first', () => {
  const { tmp, file } = seededDb();
  const r = run('seed.js', ['--reset'], { DATABASE_FILE: file, BACKUP_DIR: path.join(tmp, 'bk') });
  assert.strictEqual(r.status, 0, r.stderr);
  const files = fs.readdirSync(path.join(tmp, 'bk')).filter((f) => f.startsWith('school-pre-reset-'));
  assert.strictEqual(files.length, 1);
  assert.ok(count(path.join(tmp, 'bk', files[0]), 'SELECT COUNT(*) n FROM users') > 0);
});

test('backup, change, restore: the data comes back exactly, and the replaced database is kept', () => {
  const { tmp, file } = seededDb();
  const bk = path.join(tmp, 'bk');
  const env = { DATABASE_FILE: file, BACKUP_DIR: bk };
  const snapshot = () => { const d = new Database(file, { readonly: true }); try {
    return ['users', 'students', 'attendance_records', 'class_sessions', 'progress_entries', 'audit_log'].map((t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n).join(',');
  } finally { d.close(); } };
  const original = snapshot();

  const b = run('backup.js', [], env);
  assert.strictEqual(b.status, 0, b.stderr);
  const backupFile = b.stdout.match(/verified: (.+)$/m)[1].trim();
  assert.ok(fs.existsSync(backupFile));

  // Change and damage-like edits after the backup.
  const d = new Database(file);
  d.prepare('DELETE FROM attendance_records').run();
  d.prepare("UPDATE users SET full_name = 'CHANGED'").run();
  d.close();
  assert.notStrictEqual(snapshot(), original);

  assert.strictEqual(run('restore.js', [backupFile], env).status, 1, 'restore must require --yes');
  const r = run('restore.js', [backupFile, '--yes'], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(snapshot(), original);
  assert.strictEqual(count(file, "SELECT COUNT(*) n FROM users WHERE full_name = 'CHANGED'"), 0);
  const pre = fs.readdirSync(bk).filter((f) => f.startsWith('school-pre-restore-'));
  assert.strictEqual(pre.length, 1);
  assert.ok(count(path.join(bk, pre[0]), "SELECT COUNT(*) n FROM users WHERE full_name = 'CHANGED'") > 0);

  // The restored database opens normally through the app's own migration path.
  const db = require('../src/db');
  db.open(file);
  assert.ok(db.get().prepare('SELECT COUNT(*) n FROM users').get().n > 0);
  db.close();
});

test('restore refuses a corrupt backup and leaves the database untouched', () => {
  const { tmp, file } = seededDb();
  const bad = path.join(tmp, 'bad.db');
  fs.writeFileSync(bad, 'this is not a database');
  const before = fs.readFileSync(file);
  const r = run('restore.js', [bad, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: path.join(tmp, 'bk') });
  assert.strictEqual(r.status, 1);
  assert.ok(fs.readFileSync(file).equals(before));
});

test('backup pruning keeps only the newest copies', () => {
  const { tmp, file } = seededDb();
  const env = { DATABASE_FILE: file, BACKUP_DIR: path.join(tmp, 'bk') };
  for (let i = 0; i < 4; i++) assert.strictEqual(run('backup.js', ['--keep', '2'], env).status, 0);
  assert.strictEqual(fs.readdirSync(path.join(tmp, 'bk')).filter((f) => f.startsWith('school-manual-')).length, 2);
});
