'use strict';
// Imports the school's calendar, timetable and yearly programmes from school-data/.
// Usage: npm run import-school-data
//        npm run import-school-data -- --teachers /path/to/teachers-private.json
//        npm run import-school-data -- --dir another/folder --dry-run
// Safe to run again after correcting a file: it updates instead of duplicating.
require('../src/env');
process.umask(0o077);
const path = require('path');
const db = require('../src/db');
const { loadFolder, importAll } = require('../src/school-import');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dir = path.resolve(opt('--dir') || path.join(__dirname, '..', 'school-data'));
const teachersFile = opt('--teachers');
const dryRun = args.includes('--dry-run');
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db');

const data = loadFolder(dir, { teachersFile });
console.log(`Reading ${dir}: ${data.calendars.length} calendar, ${data.timetables.length} timetable, ${data.programmes.length} programme file(s).`);
if (teachersFile) console.log(`Teacher names: ${Object.keys(data.teacherNames).length} from ${teachersFile}`);
else console.log('No --teachers file: teacher accounts are named by code (e.g. "Enseignant T01").');

db.open(dbFile);
const d = db.get();
if (dryRun) {
  // Run everything inside a transaction that is always rolled back.
  d.exec('SAVEPOINT dry');
  try { console.log(importAll(d, data, { log: console.log })); } finally { d.exec('ROLLBACK TO dry'); d.exec('RELEASE dry'); }
  console.log('Dry run: nothing was saved.');
} else {
  const stats = importAll(d, data, { log: console.log });
  console.log('Imported:', stats);
  if (stats.teachers) console.log(`${stats.teachers} new teacher account(s) were created switched off. Turn each one on and set a password in Administration > Accounts.`);
}
db.close();
