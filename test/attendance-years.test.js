'use strict';
// Attendance and student records: teachers only reach the current school year and their own
// classes, whatever ids, dates or query strings they put in the address. Admins keep full access.
const test = require('node:test');
const assert = require('node:assert');
const { seededDb, startApp, Client } = require('./helpers');

const { file } = seededDb();
let ctx; let d; let fx;
test.before(async () => {
  ctx = await startApp(file);
  d = ctx.db.get();
  const uid = (u) => d.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  const teacher = uid('demo.prof.maths');
  const admin = uid('demo.admin');
  const year = d.prepare('SELECT * FROM academic_years WHERE is_current = 1').get();
  // A class this teacher teaches now, and one of its students.
  const own = d.prepare(`SELECT e.student_id, e.class_id FROM enrollments e JOIN teaching_assignments ta ON ta.class_id = e.class_id
    WHERE ta.teacher_id = ? LIMIT 1`).get(teacher);
  // A current-year class the teacher does NOT teach.
  const otherClass = d.prepare(`SELECT id FROM classes WHERE year_id = ? AND id NOT IN (SELECT class_id FROM teaching_assignments WHERE teacher_id = ?) LIMIT 1`).get(year.id, teacher).id;
  // Last year: the same student, in a class the same teacher taught.
  const oldYear = Number(d.prepare("INSERT INTO academic_years (name, start_date, end_date, is_current) VALUES ('2025-2026 (test)', '2025-09-08', '2026-06-30', 0)").run().lastInsertRowid);
  const sec = d.prepare('SELECT section_id FROM classes WHERE id = ?').get(own.class_id).section_id;
  const oldClass = Number(d.prepare("INSERT INTO classes (year_id, section_id, level, name) VALUES (?, ?, 'Old', 'OLD-CLASS (test)')").run(oldYear, sec).lastInsertRowid);
  d.prepare('INSERT INTO enrollments (student_id, class_id) VALUES (?, ?)').run(own.student_id, oldClass);
  const subj = d.prepare('SELECT subject_id FROM teaching_assignments WHERE teacher_id = ? LIMIT 1').get(teacher).subject_id;
  d.prepare('INSERT INTO teaching_assignments (teacher_id, class_id, subject_id) VALUES (?, ?, ?)').run(teacher, oldClass, subj);
  const rec = d.prepare("INSERT INTO attendance_records (class_id, student_id, date, status, note, recorded_by) VALUES (?, ?, ?, 'absent', ?, ?)");
  rec.run(oldClass, own.student_id, '2026-03-10', 'OLD-YEAR-NOTE', admin);
  // This year, but recorded in a class the teacher does not teach (student moved class).
  rec.run(otherClass, own.student_id, '2026-11-08', 'OTHER-CLASS-NOTE', admin);
  // This year, in the teacher's own class.
  rec.run(own.class_id, own.student_id, '2026-11-08', 'OWN-CLASS-NOTE', admin);
  fx = { teacher, own, otherClass, oldClass, year };
});
test.after(() => ctx.server.close());

const teacher = () => new Client(ctx.base).login('demo.prof.maths');

test('teacher: past-year absences never appear on a student page, whatever "from" date is sent', async () => {
  const c = await teacher();
  for (const q of ['', '?from=2019-01-01', '?from=2026-03-01', '?from=1900-01-01']) {
    const r = await c.get(`/students/${fx.own.student_id}${q}`);
    assert.strictEqual(r.status, 200, q);
    assert.ok(!r.text.includes('OLD-YEAR-NOTE'), `old-year record leaked with ${q || 'no query'}`);
    assert.ok(r.text.includes('OWN-CLASS-NOTE'), `own class record shown with ${q || 'no query'}`);
  }
});

test('teacher: records from a class they do not teach are not shown', async () => {
  const c = await teacher();
  const r = await c.get(`/students/${fx.own.student_id}?from=1900-01-01`);
  assert.ok(!r.text.includes('OTHER-CLASS-NOTE'));
});

test('admin: still sees every year and every class, including with "from"', async () => {
  const c = await new Client(ctx.base).login('demo.admin');
  const r = await c.get(`/students/${fx.own.student_id}?from=2019-01-01`);
  assert.strictEqual(r.status, 200);
  for (const n of ['OLD-YEAR-NOTE', 'OTHER-CLASS-NOTE', 'OWN-CLASS-NOTE']) assert.ok(r.text.includes(n), n);
});

test('parent: their own child keeps the same view as before (all classes, "from" honoured)', async () => {
  const pid = d.prepare("SELECT id FROM users WHERE username = 'demo.parent'").get().id;
  d.prepare('INSERT OR IGNORE INTO guardians (parent_user_id, student_id, relationship) VALUES (?, ?, ?)').run(pid, fx.own.student_id, 'test');
  const c = await new Client(ctx.base).login('demo.parent');
  const r = await c.get(`/students/${fx.own.student_id}?from=2019-01-01`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('OWN-CLASS-NOTE') && r.text.includes('OTHER-CLASS-NOTE'));
});

test('teacher: every attendance address for a past-year class, a class they do not teach, or a made-up id is refused', async () => {
  const c = await teacher();
  for (const id of [fx.oldClass, fx.otherClass, 999999, 0, -1, 'abc', `${fx.own.class_id}abc`]) {
    for (const p of ['', '/history', '/print', '/export.csv', `?date=${fx.year.start_date}`]) {
      const r = await c.get(`/attendance/${id}${p}`);
      assert.strictEqual(r.status, 404, `/attendance/${id}${p} gave ${r.status}`);
      assert.ok(!r.text.includes('OLD-YEAR-NOTE') && !r.text.includes('OTHER-CLASS-NOTE'));
    }
    const before = d.prepare('SELECT COUNT(*) n FROM attendance_records').get().n;
    const r = await c.post(`/attendance/${id}`, { date: fx.year.start_date, [`s_${fx.own.student_id}`]: 'absent' });
    assert.strictEqual(r.status, 404, `POST /attendance/${id}`);
    assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM attendance_records').get().n, before);
  }
});

test('teacher: own class works, and attendance cannot be written for a date outside the current year', async () => {
  const c = await teacher();
  assert.strictEqual((await c.get(`/attendance/${fx.own.class_id}`)).status, 200);
  const before = d.prepare('SELECT COUNT(*) n FROM attendance_records').get().n;
  for (const date of ['2026-03-10', '2019-10-10']) {
    await c.get(`/attendance/${fx.own.class_id}`);
    const r = await c.post(`/attendance/${fx.own.class_id}`, { date, [`s_${fx.own.student_id}`]: 'late' });
    assert.strictEqual(r.status, 302);
    assert.match(c.cookies.flash || '', /attendance\.badDate/, date);
  }
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM attendance_records').get().n, before);
});

test('teacher: export and printed register only contain the current year, even with wider dates', async () => {
  const c = await teacher();
  const csv = await c.get(`/attendance/${fx.own.class_id}/export.csv?from=1900-01-01&to=2100-01-01`);
  assert.strictEqual(csv.status, 200);
  for (const line of csv.text.split('\n').slice(1).filter(Boolean)) {
    const date = line.split(',')[0].replace(/"/g, '');
    assert.ok(date >= fx.year.start_date && date <= fx.year.end_date, `exported ${date}`);
  }
  assert.ok(!csv.text.includes('OLD-YEAR-NOTE'));
  const pr = await c.get(`/attendance/${fx.own.class_id}/print?week=2019-10-10`);
  assert.strictEqual(pr.status, 200);
  assert.ok(!pr.text.includes('2019-10'), 'register week is kept inside the current year');
});
