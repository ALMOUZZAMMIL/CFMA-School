'use strict';
// Replaces the database with a backup copy. STOP THE SERVER FIRST.
// Usage: npm run restore -- <backup-file> --yes
// The current database is itself backed up (label "pre-restore") before it is replaced,
// so a restore can always be undone.
require('../src/env');
process.umask(0o077); // database and backup files private to this account
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const backup = require('../src/backup');
const serverLock = require('../src/server-lock');

const dbFile = path.resolve(process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db'));
const source = process.argv[2] && path.resolve(process.argv[2]);
if (!source || !process.argv.includes('--yes')) {
  console.error('Usage: npm run restore -- <backup-file> --yes\nStop the server before restoring. The current database is backed up first.');
  process.exit(1);
}
if (source === dbFile) { console.error('The backup file is the live database itself.'); process.exit(1); }
try {
  backup.verifyRestorable(source);
} catch (e) {
  console.error(`The backup cannot be used: ${e.message}. Nothing was changed.`);
  process.exit(1);
}
const running = serverLock.runningServer(dbFile);
if (running) {
  console.error(`The server is running (process ${running}) and using this database. Stop it first, then restore. Nothing was changed.`);
  process.exit(1);
}
const lock = `${dbFile}-restore.lock`;
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { console.error(`Another restore seems to be running (${lock}).`); process.exit(1); }
try {
  if (fs.existsSync(dbFile)) {
    const dir = backup.backupDir(dbFile);
    try {
      const cur = new Database(dbFile, { fileMustExist: true });
      try {
        // Fold any pending write-ahead log into the main file, then keep a verified copy.
        cur.pragma('wal_checkpoint(TRUNCATE)');
        const saved = backup.createBackup(cur, { dir, label: 'pre-restore' });
        console.log(`Current database saved as: ${saved}`);
      } finally { cur.close(); }
    } catch (e) {
      // The live database is damaged (usually the reason for restoring). Keep its raw files
      // for investigation and carry on with the restore.
      const kept = backup.rawCopy(dbFile, { dir, label: 'pre-restore-damaged' });
      console.warn(`The current database could not be copied normally (${e.message}).\nIts raw files were kept instead: ${kept.join(', ')}`);
    }
  }
  const tmp = `${dbFile}.restoring`;
  backup.privately(() => fs.copyFileSync(source, tmp));
  backup.secureFile(tmp);
  for (const f of [`${dbFile}-wal`, `${dbFile}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  fs.renameSync(tmp, dbFile);
  backup.verifyBackup(dbFile);
  console.log(`Database restored from ${source}. Start the server again; any newer migrations will run automatically (with their own backup).`);
} catch (e) {
  console.error(`Restore failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  fs.unlinkSync(lock);
}
