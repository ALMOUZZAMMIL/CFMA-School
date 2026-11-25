'use strict';
// Reads and checks the environment settings once, so a typo stops the server at start-up
// with a clear message instead of causing odd behaviour later.
const fs = require('fs');
const path = require('path');

const ROLES = ['admin', 'bursar', 'teacher', 'parent', 'student'];
// Minutes without activity before a sign-in ends. Staff who handle money or accounts get less.
const IDLE_DEFAULTS = { admin: 30, bursar: 30, teacher: 240, parent: 120, student: 60 };
// Longest a sign-in can last, whatever the activity, in hours. Non-privileged roles use SESSION_DAYS.
const PRIVILEGED_MAX_HOURS = 12;

class ConfigError extends Error {}

function load(env = process.env) {
  const problems = [];
  const intVar = (name, def, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    if (!/^\d+$/.test(String(raw).trim())) { problems.push(`${name} must be a whole number (got "${raw}")`); return def; }
    const n = Number(raw);
    if (n < min || n > max) problems.push(`${name} must be between ${min} and ${max} (got ${n})`);
    return n;
  };
  const flag = (name) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return false;
    if (raw !== '0' && raw !== '1') problems.push(`${name} must be 0 or 1 (got "${raw}")`);
    return raw === '1';
  };

  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'production', 'test'].includes(nodeEnv)) problems.push(`NODE_ENV must be development, production or test (got "${nodeEnv}")`);
  const production = nodeEnv === 'production';

  const idle = {};
  for (const role of ROLES) idle[role] = intVar(`IDLE_MINUTES_${role.toUpperCase()}`, IDLE_DEFAULTS[role], 5, 1440);

  const logLevel = env.LOG_LEVEL || (nodeEnv === 'test' ? 'warn' : 'info');
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) problems.push(`LOG_LEVEL must be debug, info, warn, error or silent (got "${logLevel}")`);

  const databaseFile = env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db');
  if (databaseFile !== ':memory:') {
    const dir = path.dirname(path.resolve(databaseFile));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      problems.push(`DATABASE_FILE folder is not writable: ${dir}`);
    }
  }

  const cfg = {
    nodeEnv,
    production,
    port: intVar('PORT', 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    trustProxy: flag('TRUST_PROXY'),
    cookieSecure: flag('COOKIE_SECURE') || production,
    sessionDays: intVar('SESSION_DAYS', 7, 1, 90),
    privilegedMaxHours: intVar('SESSION_MAX_HOURS_PRIVILEGED', PRIVILEGED_MAX_HOURS, 1, 72),
    idleMinutes: idle,
    databaseFile,
    // At most a week: longer timers overflow in Node.js and would fire every millisecond.
    backupIntervalHours: intVar('BACKUP_INTERVAL_HOURS', 24, 0, 168),
    backupKeep: intVar('BACKUP_KEEP', 14, 1, 1000),
    allowDemoInProduction: flag('ALLOW_DEMO_IN_PRODUCTION'),
    hstsMaxAge: intVar('HSTS_MAX_AGE', 15552000, 0, 63072000),
    logLevel,
  };
  if (problems.length) {
    const e = new ConfigError(`Invalid settings in the environment or .env file:\n  - ${problems.join('\n  - ')}`);
    e.problems = problems;
    throw e;
  }
  return Object.freeze(cfg);
}

let cached;
function get() { if (!cached) cached = load(); return cached; }
// For tests that change the environment.
function reset() { cached = undefined; }

module.exports = { load, get, reset, ConfigError, IDLE_DEFAULTS, ROLES };
