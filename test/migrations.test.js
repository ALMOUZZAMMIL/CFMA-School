'use strict';
// Versioned migrations: applied once, in order, inside transactions, with a verified backup
// written before any migration touches a database that already holds data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const migrate = require('../src/migrate');
const backup = require('../src/backup');
const baseline = require('../src/migrations/001-baseline');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-mig-'));
  return { dir, file: path.join(dir, 'school.db'), backups: path.join(dir, 'backups') };
}
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

test('a new database gets every migration once, and no backup is needed', () => {
  const t = tmpDb();
  const d = new Database(t.file);
  const r = migrate.run(d, { file: t.file });
  assert.deepStrictEqual(r.applied, migrate.ALL.map((m) => m.version));
  assert.strictEqual(r.backupFile, null);
  const again = migrate.run(d, { file: t.file });
  assert.deepStrictEqual(again.applied, []);
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, migrate.ALL.length);
  d.close();
  assert.deepStrictEqual(list(t.backups), []);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('an existing database from before versioned migrations is backed up, then upgraded without losing data', () => {
  const t = tmpDb();
  const old = new Database(t.file);
  baseline.up(old); // release-1 tables, no schema_migrations, no email column
  old.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('kept.user', 'x', 'Kept User', 'teacher')").run();
  const r = migrate.run(old, { file: t.file });
  assert.ok(r.backupFile && fs.existsSync(r.backupFile), 'backup written');
  assert.match(path.basename(r.backupFile), /^school-pre-migration-v0-to-v\d+-/);
  assert.ok(backup.verifyBackup(r.backupFile));
  const copy = new Database(r.backupFile, { readonly: true });
  assert.strictEqual(copy.prepare("SELECT full_name FROM users WHERE username = 'kept.user'").get().full_name, 'Kept User');
  copy.close();
  assert.strictEqual(old.prepare("SELECT full_name FROM users WHERE username = 'kept.user'").get().full_name, 'Kept User');
  const cols = old.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('email'));
  old.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('a failing migration is rolled back completely and not recorded', () => {
  const t = tmpDb();
  const d = new Database(t.file);
  migrate.run(d, { file: t.file });
  d.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('kept.user', 'x', 'Kept User', 'teacher')").run();
  const broken = { version: 999, name: 'broken', up(x) { x.exec('CREATE TABLE half_done (id INTEGER)'); x.exec("UPDATE users SET full_name = 'CHANGED'"); throw new Error('boom'); } };
  assert.throws(() => migrate.run(d, { file: t.file, migrations: [...migrate.ALL, broken] }), (e) => /Migration 999 \(broken\) failed and was rolled back: boom/.test(e.message) && fs.existsSync(e.backupFile));
  assert.strictEqual(d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get(), undefined, 'table creation rolled back');
  assert.strictEqual(d.prepare("SELECT full_name FROM users WHERE username = 'kept.user'").get().full_name, 'Kept User', 'data change rolled back');
  assert.strictEqual(migrate.currentVersion(d), migrate.ALL[migrate.ALL.length - 1].version);
  d.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
});
