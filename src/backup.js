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

// Backups hold password hashes and pupils' records, so only the account that runs the
// application may read them: folder 700 (rwx------), files 600 (rw-------). On Windows these
// calls have no effect; protect the folder with the account's own permissions there.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    const st = fs.statSync(dir);
    // Tighten an existing folder if this account owns it (never touch someone else's folder).
    if (typeof process.getuid !== 'function' || st.uid === process.getuid()) fs.chmodSync(dir, DIR_MODE);
  } catch { /* reported by the write that follows */ }
}

function secureFile(file) {
  try { fs.chmodSync(file, FILE_MODE); } catch { /* file may not exist (failed copy) */ }
}

// Runs fn with a restrictive umask, so files are never readable by others even for a moment.
function privately(fn) {
  const old = process.umask(0o077);
  try { return fn(); } finally { process.umask(old); }
}

function uniqueName(dir, label, ext = '.db') {
  let file = path.join(dir, `school-${label}-${stamp()}${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `school-${label}-${stamp()}-${i}${ext}`);
  return file;
}

// Returns the path of the verified copy. Throws if the copy cannot be made or fails the check;
// a copy that fails is deleted, so the backups folder only ever holds usable files.
function createBackup(d, { dir, label = 'manual' }) {
  secureDir(dir);
  const file = uniqueName(dir, label);
  try {
    privately(() => d.prepare('VACUUM INTO ?').run(file));
    secureFile(file);
    verifyBackup(file);
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* nothing was written */ }
    throw err;
  }
  return file;
}

// SQLite reports "ok" for an empty file, so a copy must also be non-empty to count.
function verifyBackup(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size === 0) throw new Error('the file is empty');
  const b = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = b.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup failed its integrity check: ${result}`);
    return true;
  } finally {
    b.close();
  }
}

// Stricter check before a file replaces the live database: it must be a school database
// (core tables present) with at least one account, or the school would be locked out.
function verifyRestorable(file) {
  verifyBackup(file);
  const b = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const has = (t) => !!b.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('users') || !has('settings')) throw new Error('the file is not a school database (no users or settings table)');
    if (b.prepare('SELECT COUNT(*) n FROM users').get().n === 0) throw new Error('the file has no user accounts');
    return true;
  } finally {
    b.close();
  }
}

// Last-resort copy of the raw database files (main file and write-ahead log), used when the
// database is too damaged for SQLite to copy. Not verified: it is kept for investigation.
function rawCopy(dbFile, { dir, label }) {
  secureDir(dir);
  const base = uniqueName(dir, label, '.raw.db');
  const out = [];
  for (const [src, dst] of [[dbFile, base], [`${dbFile}-wal`, `${base}-wal`]]) {
    if (fs.existsSync(src)) { privately(() => fs.copyFileSync(src, dst)); secureFile(dst); out.push(dst); }
  }
  return out;
}

// Keeps the newest `keep` copies with this label; older ones with the same label are deleted.
function pruneBackups(dir, { label, keep }) {
  if (!fs.existsSync(dir) || !(keep > 0)) return [];
  const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`school-${label}-`) && f.endsWith('.db')).sort();
  const removed = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of removed) fs.unlinkSync(path.join(dir, f));
  return removed;
}

// The scheduled backup run by the server: one verified copy, then old automatic copies removed.
function autoBackup(d, dbFile, { keep }) {
  const dir = backupDir(dbFile);
  const file = createBackup(d, { dir, label: 'auto' });
  const removed = pruneBackups(dir, { label: 'auto', keep });
  return { file, removed };
}

module.exports = { backupDir, createBackup, autoBackup, secureDir, secureFile, privately, DIR_MODE, FILE_MODE, verifyBackup, verifyRestorable, rawCopy, pruneBackups, stamp };
