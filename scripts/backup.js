'use strict';
// Writes a verified copy of the database. Safe to run while the server is running.
// Usage: npm run backup                 (copy kept in BACKUP_DIR or <database folder>/backups)
//        npm run backup -- --keep 30    (also delete older manual copies, keeping the newest 30)
require('../src/env');
process.umask(0o077); // database and backup files private to this account
const path = require('path');
const Database = require('better-sqlite3');
const backup = require('../src/backup');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db');
const i = process.argv.indexOf('--keep');
const keep = i > -1 ? Number(process.argv[i + 1]) : 0;
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'manual';
if (!/^[a-z0-9-]{1,30}$/.test(label)) { console.error('Label: lowercase letters, numbers and dashes only.'); process.exit(1); }

let d;
try {
  d = new Database(dbFile, { fileMustExist: true });
} catch (e) {
  console.error(`Cannot open the database at ${dbFile}: ${e.message}`);
  process.exit(1);
}
try {
  const dir = backup.backupDir(dbFile);
  const file = backup.createBackup(d, { dir, label });
  console.log(`Backup written and verified: ${file}`);
  if (keep > 0) for (const f of backup.pruneBackups(dir, { label, keep })) console.log(`Old backup removed: ${f}`);
} catch (e) {
  console.error(`Backup failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  d.close();
}
