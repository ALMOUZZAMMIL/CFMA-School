'use strict';
// A small marker file that says "a server is using this database". Restore and the demo reset
// refuse to replace the database while a live server holds it, because the running server
// would keep using the old file and anything saved afterwards would be lost.
const fs = require('fs');
const path = require('path');

function lockFile(dbFile) { return `${path.resolve(dbFile)}.server.lock`; }

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Returns the process id of a live server using this database, or null.
// A marker left by a server that crashed (its process no longer exists) is ignored.
function runningServer(dbFile) {
  const f = lockFile(dbFile);
  if (!fs.existsSync(f)) return null;
  const pid = Number(String(fs.readFileSync(f, 'utf8')).trim());
  return pid !== process.pid && alive(pid) ? pid : null;
}

function acquire(dbFile) {
  const other = runningServer(dbFile);
  if (other) throw new Error(`another server (process ${other}) is already using ${dbFile}`);
  fs.writeFileSync(lockFile(dbFile), String(process.pid));
}

function release(dbFile) {
  const f = lockFile(dbFile);
  try { if (Number(fs.readFileSync(f, 'utf8')) === process.pid) fs.unlinkSync(f); } catch { /* already gone */ }
}

module.exports = { lockFile, runningServer, acquire, release };
