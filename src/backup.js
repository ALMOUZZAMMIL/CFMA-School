'use strict';
// Consistent copies of the SQLite database. "VACUUM INTO" writes a complete, compacted copy
// while the application keeps running, and each copy is checked with PRAGMA integrity_check.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function backupDir(dbFile) {
  return process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dbFile)), 'backups');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

// Returns the path of the verified copy. Throws if the copy cannot be made or fails the check.
function createBackup(d, { dir, label = 'manual' }) {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `school-${label}-${stamp()}.db`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `school-${label}-${stamp()}-${i}.db`);
  d.prepare('VACUUM INTO ?').run(file);
  verifyBackup(file);
  return file;
}

function verifyBackup(file) {
  const b = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = b.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup failed its integrity check: ${result}`);
    return true;
  } finally {
    b.close();
  }
}

// Keeps the newest `keep` copies with this label; older ones with the same label are deleted.
function pruneBackups(dir, { label, keep }) {
  if (!fs.existsSync(dir) || !(keep > 0)) return [];
  const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`school-${label}-`) && f.endsWith('.db')).sort();
  const removed = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of removed) fs.unlinkSync(path.join(dir, f));
  return removed;
}

module.exports = { backupDir, createBackup, verifyBackup, pruneBackups, stamp };
