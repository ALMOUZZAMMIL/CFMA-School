'use strict';
// Structured logs: one JSON object per line on stdout (info) or stderr (warnings, errors),
// easy to read with journalctl or any log tool. Never log passwords, tokens or form bodies.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let threshold;

function level() {
  if (threshold === undefined) {
    let name = process.env.LOG_LEVEL;
    if (!LEVELS[name]) name = process.env.NODE_ENV === 'test' ? 'warn' : 'info';
    threshold = LEVELS[name];
  }
  return threshold;
}

function write(lvl, msg, fields) {
  if (LEVELS[lvl] < level()) return;
  const entry = { time: new Date().toISOString(), level: lvl, msg, ...fields };
  if (fields && fields.err instanceof Error) {
    entry.err = { message: fields.err.message, name: fields.err.name, stack: fields.err.stack, status: fields.err.status };
  }
  let line;
  try { line = JSON.stringify(entry); } catch { line = JSON.stringify({ time: entry.time, level: lvl, msg }); }
  (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

module.exports = {
  debug: (m, f) => write('debug', m, f),
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f),
  setLevel: (name) => { threshold = LEVELS[name] ?? LEVELS.info; },
};
