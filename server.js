'use strict';
const fs = require('fs');
const path = require('path');

// Load .env if present (simple KEY=VALUE lines, no extra dependency needed).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = require('./src/db');
db.open();
const { createApp } = require('./src/app');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
createApp().listen(port, host, () => {
  console.log(`School system running on http://localhost:${port}`);
});

// Remove expired sessions once an hour.
setInterval(() => {
  db.get().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}, 3600000).unref();
