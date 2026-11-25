'use strict';
// The school's own data (school-data/): it imports cleanly, importing again changes nothing,
// it carries no personal data, and the timetable grid is built correctly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const migrate = require('../src/migrate');
const { loadFolder, importAll, mergePeriods } = require('../src/school-import');
const grid = require('../src/timetable-grid');

const DIR = path.join(__dirname, '..', 'school-data');
function freshDb() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  migrate.run(d);
  return d;
}

test('school data imports, and a second import adds nothing', () => {
  const d = freshDb();
  const data = loadFolder(DIR);
  const first = importAll(d, data);
  assert.ok(first.events > 20 && first.slots > 100 && first.teachers > 10, JSON.stringify(first));
  const count = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const before = ['users', 'classes', 'teaching_assignments', 'timetable_slots', 'school_events', 'plan_lessons'].map(count);
  const second = importAll(d, data);
  assert.deepStrictEqual(['users', 'classes', 'teaching_assignments', 'timetable_slots', 'school_events', 'plan_lessons'].map(count), before);
  assert.strictEqual(second.slots + second.teachers + second.classes, 0);
  // Imported teacher accounts cannot sign in until an administrator turns them on.
  assert.strictEqual(d.prepare("SELECT COUNT(*) n FROM users WHERE role = 'teacher' AND active = 1").get().n, 0);
});

test('the repository copy holds no teacher names or phone numbers', () => {
  const tt = JSON.parse(fs.readFileSync(path.join(DIR, 'timetable-2026-2027.json'), 'utf8'));
  for (const t of tt.teachers) assert.deepStrictEqual(Object.keys(t).filter((k) => k !== 'code' && k !== 'language'), []);
  for (const f of fs.readdirSync(DIR, { recursive: true }).filter((x) => String(x).endsWith('.json'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(DIR, String(f)), 'utf8'), /\b6[5-9]\d[ .]?\d{2}[ .]?\d{2}[ .]?\d{2}\b/, `${f} contains something like a phone number`);
  }
});

test('real names come from the private file when it is given', () => {
  const d = freshDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  const file = path.join(tmp, 'teachers.json');
  fs.writeFileSync(file, JSON.stringify({ teachers: { T01: 'Mme Exemple Test' } }));
  importAll(d, loadFolder(DIR, { teachersFile: file }));
  assert.ok(d.prepare("SELECT 1 FROM users WHERE full_name = 'Mme Exemple Test' AND username = 'mme.exemple.test.t01'").get());
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('touching periods become one lesson; a break splits them', () => {
  const periods = [{ n: 1, start: '07:30', end: '08:25' }, { n: 2, start: '08:25', end: '09:20' }, { n: 3, start: '09:20', end: '10:15' }, { n: 4, start: '10:30', end: '11:25' }];
  assert.deepStrictEqual(mergePeriods([1, 2], periods), [{ start: '07:30', end: '09:20' }]);
  assert.deepStrictEqual(mergePeriods([3, 4], periods), [{ start: '09:20', end: '10:15' }, { start: '10:30', end: '11:25' }]);
});

test('the week grid spans double periods and shows breaks', () => {
  const bell = [{ n: 1, start: '07:30', end: '08:25' }, { n: 2, start: '08:25', end: '09:20' }, { n: 3, start: '10:30', end: '11:25' }];
  const g = grid.build([{ id: 1, day_of_week: 1, start_time: '07:30', end_time: '09:20' }, { id: 2, day_of_week: 2, start_time: '10:30', end_time: '11:25' }], bell);
  assert.deepStrictEqual(g.days, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(g.rows.map((r) => r.type), ['period', 'period', 'break', 'period']);
  assert.strictEqual(g.rows[0].cells[1].span, 2);
  assert.ok(g.rows[1].cells[1].covered);
  assert.strictEqual(g.rows[3].cells[2].slots[0].id, 2);
});
