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

// --- Fixes found by the PR #2 verification ---

function backupOf(tmp, file) {
  const bk = path.join(tmp, 'bk');
  const b = run('backup.js', [], { DATABASE_FILE: file, BACKUP_DIR: bk });
  assert.strictEqual(b.status, 0, b.stderr);
  return { bk, backupFile: b.stdout.match(/verified: (.+)$/m)[1].trim() };
}

test('restore still works when the live database is damaged, and keeps its raw files', () => {
  const { tmp, file } = seededDb();
  const { bk, backupFile } = backupOf(tmp, file);
  const users = count(backupFile, 'SELECT COUNT(*) n FROM users');
  for (const damage of ['pages', 'header']) {
    const fd = fs.openSync(file, 'r+');
    if (damage === 'pages') fs.writeSync(fd, Buffer.alloc(8192, 0xff), 0, 8192, 4096 * 3);
    else fs.writeSync(fd, Buffer.from('garbage'.repeat(20)), 0, 140, 0);
    fs.closeSync(fd);
    const r = run('restore.js', [backupFile, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: bk });
    assert.strictEqual(r.status, 0, `${damage}: ${r.stderr}`);
    assert.match(r.stderr, /raw files were kept/);
    assert.strictEqual(count(file, 'SELECT COUNT(*) n FROM users'), users);
  }
  assert.strictEqual(fs.readdirSync(bk).filter((f) => f.includes('pre-restore-damaged') && f.endsWith('.raw.db')).length, 2);
  assert.ok(!fs.readdirSync(bk).some((f) => fs.statSync(path.join(bk, f)).size === 0), 'no empty files left in the backups folder');
});

test('restore refuses an empty file, a non-school database and a database with no accounts', () => {
  const { tmp, file } = seededDb();
  const before = fs.readFileSync(file);
  const empty = path.join(tmp, 'empty.db');
  fs.writeFileSync(empty, '');
  const other = path.join(tmp, 'other.db');
  const o = new Database(other); o.exec('CREATE TABLE notes (x TEXT)'); o.close();
  const noUsers = path.join(tmp, 'nousers.db');
  const n = new Database(noUsers); n.exec('CREATE TABLE users (id INTEGER); CREATE TABLE settings (key TEXT)'); n.close();
  for (const [f, why] of [[empty, /empty/], [other, /not a school database/], [noUsers, /no user accounts/]]) {
    const r = run('restore.js', [f, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: path.join(tmp, 'bk') });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, why);
  }
  assert.ok(fs.readFileSync(file).equals(before));
});

test('a backup that fails its check is deleted, not left looking valid', () => {
  const { tmp, file } = seededDb();
  const backup = require('../src/backup');
  const dir = path.join(tmp, 'bk');
  const d = new Database(file);
  d.close(); // closed connection: VACUUM INTO throws
  assert.throws(() => backup.createBackup(d, { dir, label: 'manual' }));
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('restore and demo reset refuse while a server is using the database; a stale marker is ignored', () => {
  const { tmp, file } = seededDb();
  const { bk, backupFile } = backupOf(tmp, file);
  const lock = require('../src/server-lock').lockFile(file);
  // A live process (this test runner) holds the marker.
  fs.writeFileSync(lock, String(process.ppid || process.pid));
  const before = fs.readFileSync(file);
  const r = run('restore.js', [backupFile, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: bk });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /server is running/);
  const s = run('seed.js', ['--reset'], { DATABASE_FILE: file, BACKUP_DIR: bk });
  assert.strictEqual(s.status, 2);
  assert.match(s.stderr, /server is running/);
  assert.ok(fs.readFileSync(file).equals(before));
  // A marker from a process that no longer exists does not block a restore.
  fs.writeFileSync(lock, '999999');
  assert.strictEqual(run('restore.js', [backupFile, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: bk }).status, 0);
  fs.unlinkSync(lock);
});

test('a real running server blocks restore, and releases the database when it stops', async () => {
  const { tmp, file } = seededDb();
  const { bk, backupFile } = backupOf(tmp, file);
  const { spawn } = require('child_process');
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: file, PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'info', BACKUP_INTERVAL_HOURS: '0' } });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no start: ${out}`)), 8000);
    p.stdout.on('data', () => { if (out.includes('"server started"')) { clearTimeout(t); resolve(); } });
  });
  const r = run('restore.js', [backupFile, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: bk });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, new RegExp(`process ${p.pid}`));
  const second = run('../server.js', [], { DATABASE_FILE: file, PORT: '0' });
  assert.strictEqual(second.status, 1, 'a second server on the same database is refused');
  const exit = new Promise((resolve) => p.on('exit', resolve));
  p.kill('SIGTERM');
  assert.strictEqual(await exit, 0);
  assert.ok(!fs.existsSync(require('../src/server-lock').lockFile(file)), 'marker removed on stop');
  assert.strictEqual(run('restore.js', [backupFile, '--yes'], { DATABASE_FILE: file, BACKUP_DIR: bk }).status, 0);
});

test('the automatic backup interval is capped at one week', () => {
  const config = require('../src/config');
  assert.throws(() => config.load({ BACKUP_INTERVAL_HOURS: '720' }), /BACKUP_INTERVAL_HOURS must be between 0 and 168/);
  assert.strictEqual(config.load({ BACKUP_INTERVAL_HOURS: '168' }).backupIntervalHours, 168);
});

// --- Backup file permissions (shared servers) ---
const mode = (f) => fs.statSync(f).mode & 0o777;
const posix = process.platform !== 'win32';

test('backups are private to the application account: folder 700, files 600 (manual, automatic, pre-migration, pre-restore)', { skip: !posix }, () => {
  const { tmp, file } = seededDb();
  const bk = path.join(tmp, 'bk');
  // An existing, too-open folder is tightened.
  fs.mkdirSync(bk, { mode: 0o755 }); fs.chmodSync(bk, 0o755);
  // Run under a permissive umask to prove the code does not rely on the system default.
  const env = { DATABASE_FILE: file, BACKUP_DIR: bk };
  const manual = spawnSync('sh', ['-c', `umask 022 && "${process.execPath}" "${path.join(ROOT, 'scripts', 'backup.js')}"`], { env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8' });
  assert.strictEqual(manual.status, 0, manual.stderr);
  assert.strictEqual(mode(bk), 0o700);

  const backup = require('../src/backup');
  const old = process.umask(0o022);
  try {
    process.env.BACKUP_DIR = bk;
    const d = new Database(file);
    try {
      backup.autoBackup(d, file, { keep: 5 });
      // pre-migration copy, written by the migration runner
      require('../src/migrate').run(d, { file, migrations: [...require('../src/migrate').ALL, { version: 900, name: 'noop', up() {} }] });
    } finally { d.close(); }
  } finally { process.umask(old); delete process.env.BACKUP_DIR; }

  const r = run('restore.js', [path.join(bk, fs.readdirSync(bk).find((f) => f.startsWith('school-manual-'))), '--yes'], env);
  assert.strictEqual(r.status, 0, r.stderr);
  const files = fs.readdirSync(bk);
  for (const prefix of ['school-manual-', 'school-auto-', 'school-pre-migration-', 'school-pre-restore-']) {
    const f = files.find((x) => x.startsWith(prefix));
    assert.ok(f, `${prefix} backup exists`);
    assert.strictEqual(mode(path.join(bk, f)), 0o600, `${f} is ${mode(path.join(bk, f)).toString(8)}`);
  }
  assert.strictEqual(mode(file), 0o600, 'restored database is private too');
  // The restored database is a working school database.
  assert.ok(count(file, 'SELECT COUNT(*) n FROM users') > 0);
});

test('raw copies of a damaged database are private too', { skip: !posix }, () => {
  const { tmp, file } = seededDb();
  const backup = require('../src/backup');
  const dir = path.join(tmp, 'raw');
  const old = process.umask(0o022);
  try { for (const f of backup.rawCopy(file, { dir, label: 'x' })) assert.strictEqual(mode(f), 0o600); } finally { process.umask(old); }
  assert.strictEqual(mode(dir), 0o700);
});
