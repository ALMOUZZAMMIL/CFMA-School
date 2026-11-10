'use strict';
require('./src/env');

const config = require('./src/config');
const log = require('./src/log');

let cfg;
try {
  cfg = config.get();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const db = require('./src/db');
const backup = require('./src/backup');
const auth = require('./src/auth');
const publicRoutes = require('./src/routes/public');

try {
  db.open(cfg.databaseFile);
} catch (e) {
  log.error('could not open or upgrade the database; the server was not started', { err: e, backupFile: e.backupFile });
  process.exit(1);
}

// A demonstration database (fictional people, shared demo password) must not be served as
// the real school site by accident.
if (cfg.production && db.getSettings().demo_mode === '1' && !cfg.allowDemoInProduction) {
  log.error('refusing to start: NODE_ENV=production but the database holds DEMO data (demo_mode=1). Use a real database, or set ALLOW_DEMO_IN_PRODUCTION=1 for a public demonstration site.');
  db.close();
  process.exit(1);
}

const { createApp } = require('./src/app');
const server = createApp().listen(cfg.port, cfg.host, () => {
  const { port } = server.address();
  log.info('server started', { url: `http://localhost:${port}`, port, env: cfg.nodeEnv, database: cfg.databaseFile });
});

const timers = [];
// Remove expired sessions once an hour.
timers.push(setInterval(() => {
  try { db.get().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); } catch (err) { log.error('session purge failed', { err }); }
}, 3600000));
// Clear old rate-limit entries every 10 minutes.
timers.push(setInterval(() => { auth.pruneAttempts(); publicRoutes.limiter.pruneHits(); }, 600000));
// Automatic verified backup (BACKUP_INTERVAL_HOURS=0 turns it off).
if (cfg.backupIntervalHours > 0) {
  timers.push(setInterval(() => {
    try {
      const dir = backup.backupDir(cfg.databaseFile);
      const file = backup.createBackup(db.get(), { dir, label: 'auto' });
      const removed = backup.pruneBackups(dir, { label: 'auto', keep: cfg.backupKeep });
      log.info('automatic backup written', { file, removed: removed.length });
    } catch (err) {
      log.error('automatic backup failed', { err });
    }
  }, cfg.backupIntervalHours * 3600000));
}
for (const t of timers) t.unref();

// Graceful shutdown: stop taking new requests, let current ones finish, then close the
// database cleanly (this also folds the write-ahead log into the main file).
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  for (const t of timers) clearInterval(t);
  const force = setTimeout(() => {
    log.error('shutdown took longer than 10 seconds; forcing exit');
    try { db.close(); } catch { /* already closed */ }
    process.exit(1);
  }, 10000);
  force.unref();
  server.close(() => {
    try { db.close(); } catch (err) { log.error('database close failed', { err }); }
    log.info('stopped');
    process.exit(signal === 'uncaughtException' ? 1 : 0);
  });
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', { err }));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception; stopping', { err });
  shutdown('uncaughtException');
});
