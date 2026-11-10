'use strict';
// Versioned migrations. Before any pending migration runs on a database that already holds
// data, a verified backup is written. Each migration runs in its own transaction and is
// recorded in schema_migrations, so it is applied exactly once.
const backup = require('./backup');
const ALL = require('./migrations');

function ensureTable(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function currentVersion(d) {
  ensureTable(d);
  return d.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations').get().v;
}

function hasData(d) {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations') AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
}

function run(d, { file, migrations = ALL, log = () => {} } = {}) {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const from = currentVersion(d);
  const pending = sorted.filter((m) => m.version > from);
  if (!pending.length) return { from, to: from, applied: [], backupFile: null };
  const to = pending[pending.length - 1].version;

  let backupFile = null;
  if (file && file !== ':memory:' && hasData(d)) {
    backupFile = backup.createBackup(d, { dir: backup.backupDir(file), label: `pre-migration-v${from}-to-v${to}` });
    log(`Backup written before migrating: ${backupFile}`);
  }

  const record = d.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  const applied = [];
  for (const m of pending) {
    try {
      d.transaction(() => { m.up(d); record.run(m.version, m.name); })();
      applied.push(m.version);
      log(`Applied migration ${m.version} (${m.name})`);
    } catch (err) {
      const where = backupFile ? ` The database was backed up first: ${backupFile}` : '';
      const e = new Error(`Migration ${m.version} (${m.name}) failed and was rolled back: ${err.message}.${where}`);
      e.cause = err;
      e.backupFile = backupFile;
      throw e;
    }
  }
  return { from, to, applied, backupFile };
}

module.exports = { run, currentVersion, ALL };
