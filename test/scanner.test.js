'use strict';
// Fingerprint scanner attendance: the matching rules, the device connection, and who can
// change what. Scans must be impossible to alter, and teachers must not edit scanned lessons.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { seededDb, startApp, Client } = require('./helpers');

let ctx; let dbInfo; let scanner;
before(async () => { dbInfo = seededDb(); ctx = await startApp(dbInfo.file); scanner = require('../src/scanner'); });
after(() => { ctx.server.close(); fs.rmSync(dbInfo.tmp, { recursive: true, force: true }); });

const q = (sql, ...a) => ctx.db.get().prepare(sql).get(...a);
const RULES = { grace: 15, lateLimit: 30, early: 10, exitWait: 30, double: 2, backToBack: 10 };
let n = 0;
const scan = (time, date = '2026-11-23') => ({ id: ++n, scanned_at: `${date} ${time.length === 5 ? `${time}:00` : time}` });
const slot = (id, start, end) => ({ id, start_time: start, end_time: end });
const states = (res) => res.lessons.map((l) => l.state);
const match = (slots, times, nowMin = Infinity) => scanner.matchDay({ slots, scans: times.map((t) => scan(t)), nowMin, rules: RULES });

/* ---------- Matching rules ---------- */

test('scan out and back: the lesson is finished, on time', () => {
  const res = match([slot(1, '07:30', '08:25')], ['07:28', '08:27']);
  assert.deepStrictEqual(states(res), ['done']);
  assert.strictEqual(res.lessons[0].lateMin, 0);
  assert.strictEqual(res.lessons[0].earlyMin, 0);
});

test('a first scan 20 minutes late is finished but flagged late; 40 minutes late needs a decision', () => {
  const late = match([slot(1, '07:30', '08:25')], ['07:50', '08:25']);
  assert.deepStrictEqual(states(late), ['done']);
  assert.strictEqual(late.lessons[0].lateMin, 20);
  assert.deepStrictEqual(states(match([slot(1, '07:30', '08:25')], ['08:10', '08:25'])), ['review']);
});

test('a scan back long before the end is flagged as leaving early', () => {
  const res = match([slot(1, '07:30', '08:25')], ['07:29', '08:00']);
  assert.deepStrictEqual(states(res), ['done']);
  assert.strictEqual(res.lessons[0].earlyMin, 25);
});

test('no scan back: in class during the lesson, unconfirmed 30 minutes after it ends', () => {
  const slots = [slot(1, '07:30', '08:25')];
  assert.deepStrictEqual(states(match(slots, ['07:28'], 8 * 60)), ['in_class']);
  assert.deepStrictEqual(states(match(slots, ['07:28'], 8 * 60 + 50)), ['in_class']);
  assert.deepStrictEqual(states(match(slots, ['07:28'], 9 * 60)), ['unconfirmed']);
});

test('no scan at all: waiting until the late limit, then no scan', () => {
  const slots = [slot(1, '10:00', '10:55')];
  assert.deepStrictEqual(states(match(slots, [], 10 * 60 + 10)), ['waiting']);
  assert.deepStrictEqual(states(match(slots, [], 10 * 60 + 31)), ['no_scan']);
});

test('back-to-back lessons are covered by one scan out and one scan back', () => {
  const res = match([slot(1, '07:30', '08:25'), slot(2, '08:25', '09:20')], ['07:27', '09:22']);
  assert.deepStrictEqual(states(res), ['done', 'done']);
});

test('a scan between back-to-back lessons ends the first and starts the second', () => {
  const res = match([slot(1, '07:30', '08:25'), slot(2, '08:30', '09:25')], ['07:27', '08:26', '09:26']);
  assert.deepStrictEqual(states(res), ['done', 'done']);
  assert.strictEqual(res.lessons[1].inScan.scanned_at, '2026-11-23 08:26:00');
});

test('two scans a few seconds apart count as one', () => {
  const res = match([slot(1, '07:30', '08:25')], ['07:28:00', '07:28:40', '08:26']);
  assert.deepStrictEqual(states(res), ['done']);
  assert.strictEqual(res.lessons[0].outScan.scanned_at, '2026-11-23 08:26:00');
});

test('a scan outside every lesson is not used (it goes to the "no lesson" list)', () => {
  const res = match([slot(1, '07:30', '08:25')], ['07:28', '08:26', '15:00']);
  assert.strictEqual(res.usedScanIds.size, 2);
});

test('lessons later in the day stay separate', () => {
  const res = match([slot(1, '07:30', '08:25'), slot(2, '10:30', '11:25')], ['07:28', '08:26', '10:31', '11:26']);
  assert.deepStrictEqual(states(res), ['done', 'done']);
  assert.strictEqual(res.lessons[1].inScan.scanned_at, '2026-11-23 10:31:00');
});

test('the scan back of a lesson is not reused as the first scan of a later, separate lesson', () => {
  const res = match([slot(1, '09:30', '10:15'), slot(2, '10:30', '11:25')], ['09:28', '10:16', '10:26', '11:26']);
  assert.deepStrictEqual(states(res), ['done', 'done']);
  assert.strictEqual(res.lessons[0].outScan.scanned_at, '2026-11-23 10:16:00');
  assert.strictEqual(res.lessons[1].inScan.scanned_at, '2026-11-23 10:26:00');
  assert.strictEqual(res.lessons[1].earlyMin, 0);
});

test('a scan just before the next lesson starts it, rather than counting as very late for this one', () => {
  const res = match([slot(1, '07:30', '09:20'), slot(2, '09:30', '10:25')], ['09:16', '10:26'], 11 * 60);
  assert.deepStrictEqual(states(res), ['no_scan', 'done']);
  assert.strictEqual(res.lessons[1].inScan.scanned_at, '2026-11-23 09:16:00');
});

test('one teacher with two classes at the same time: one pair of scans covers both', () => {
  const res = match([slot(1, '07:30', '08:25'), slot(2, '07:30', '08:25')], ['07:28', '08:27']);
  assert.deepStrictEqual(states(res), ['done', 'done']);
});

test('USB attendance files and device lines are read the same way', () => {
  const { scans, skipped } = scanner.parseLog('    12\t2026-11-23 07:28:04\t0\t1\t0\t0\n7,2026/11/23 08:30\nnot a scan\n');
  assert.deepStrictEqual(scans, [{ pin: '12', scanned_at: '2026-11-23 07:28:04' }, { pin: '7', scanned_at: '2026-11-23 08:30:00' }]);
  assert.strictEqual(skipped, 1);
});

/* ---------- The whole flow, through the portal ---------- */

const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function pastTeachingDay(teacherId) {
  const { addDays } = require('../src/util');
  for (let i = 1; i < 120; i++) {
    const d = addDays(ctx.db.get().prepare("SELECT date('now') d").get().d, -i);
    const slots = scanner.slotsFor(teacherId, d);
    if (slots.length) return { date: d, slots };
  }
  throw new Error('no past teaching day in the demo data');
}

async function device(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${ctx.base}${path}`, { method, body, headers: { 'content-type': 'text/plain' } });
  return { status: res.status, text: await res.text(), cookie: res.headers.get('set-cookie') };
}

test('scanner flow: device approval, staff numbers, lessons recorded, teachers cannot change them', async () => {
  const d = ctx.db.get();
  const teacher = q("SELECT id FROM users WHERE username = 'demo.prof.maths'");
  const day = pastTeachingDay(teacher.id);
  const { date } = day;
  // A second, late-afternoon lesson that day, to check a lesson with no scan.
  const base = q('SELECT * FROM timetable_slots WHERE id = ?', day.slots[0].id);
  d.prepare("INSERT INTO timetable_slots (assignment_id, term_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, '17:00', '17:55')").run(base.assignment_id, base.term_id, base.day_of_week);
  const slots = scanner.slotsFor(teacher.id, date);
  const first = slots[0];
  // Start from a day with nothing recorded, and a scanner in use since before it.
  d.prepare('DELETE FROM class_sessions WHERE date = ? AND slot_id IN (SELECT ts.id FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id WHERE ta.teacher_id = ?)').run(date, teacher.id);

  // 1. A new device introduces itself and is put on hold. No cookie, no session.
  const hello = await device('/iclock/cdata?SN=CQZ7231560001&options=all');
  assert.strictEqual(hello.status, 200);
  assert.match(hello.text, /GET OPTION FROM: CQZ7231560001/);
  assert.strictEqual(hello.cookie, null);
  const dev = q('SELECT * FROM scan_devices WHERE serial = ?', 'CQZ7231560001');
  assert.strictEqual(dev.status, 'pending');
  assert.strictEqual((await device('/iclock/cdata?SN=bad serial!')).status, 403);

  // 2. It sends scans for staff number 41 (not linked yet), and fingerprint data that must be thrown away.
  const inAt = `${date} ${pad(toMin(first.start_time) - 3)}:10`;
  const outAt = `${date} ${pad(toMin(first.end_time) + 2)}:05`;
  const sent = await device('/iclock/cdata?SN=CQZ7231560001&table=ATTLOG&Stamp=1', { method: 'POST', body: `41\t${inAt}\t0\t1\t0\t0\n41\t${outAt}\t1\t1\t0\t0\n` });
  assert.strictEqual(sent.text, 'OK: 2');
  const before = q('SELECT COUNT(*) n FROM scans').n;
  assert.strictEqual((await device('/iclock/cdata?SN=CQZ7231560001&table=OPERLOG', { method: 'POST', body: 'FP PIN=41\tFID=6\tSize=1184\tValid=1\tTMP=SecretTemplateData==\n' })).text, 'OK');
  assert.strictEqual(q('SELECT COUNT(*) n FROM scans').n, before);
  assert.strictEqual(fs.readFileSync(dbInfo.file).includes('SecretTemplateData'), false, 'fingerprint data never stored');
  assert.strictEqual(q('SELECT COUNT(*) n FROM class_sessions WHERE slot_id = ? AND date = ?', first.id, date).n, 0, 'pending device counts for nothing');

  // 3. The admin approves the device and gives the teacher number 41: the lesson is recorded.
  const admin = await new Client(ctx.base).login('demo.admin');
  await admin.get('/admin/scanner');
  assert.strictEqual((await admin.post(`/admin/scanner/devices/${dev.id}`, { action: 'approve', name: 'Office', allowed_ip: '' })).status, 302);
  ctx.db.setSetting('scanner_start_date', '2000-01-01');
  assert.strictEqual((await admin.post('/admin/scanner/pins', { [`pin_${teacher.id}`]: '41' })).status, 302);
  const session = q('SELECT * FROM class_sessions WHERE slot_id = ? AND date = ?', first.id, date);
  assert.ok(session, 'lesson recorded from the scans');
  assert.strictEqual(session.status, 'held');
  assert.strictEqual(session.source, 'scanner');
  assert.strictEqual(q('SELECT state FROM scan_lessons WHERE slot_id = ? AND date = ?', first.id, date).state, 'done');
  // The "where is each teacher now" page shows the scan next to the progression sheet.
  const nowPage = await admin.get(`/progress/now?date=${date}`);
  assert.strictEqual(nowPage.status, 200);
  assert.match(nowPage.text, /Présent \(scanner\)|Present \(scanner\)/);
  assert.match(nowPage.text, /Terminé|Finished/);

  // 4. Scans can never be changed or deleted, even directly in the database.
  assert.throws(() => d.prepare("UPDATE scans SET scanned_at = '2000-01-01 00:00:00' WHERE pin = '41'").run(), /cannot be changed/);
  assert.throws(() => d.prepare("DELETE FROM scans WHERE pin = '41'").run(), /cannot be deleted/);

  // 5. The teacher sees the lesson but cannot edit it or type lessons in by hand.
  const tch = await new Client(ctx.base).login('demo.prof.maths');
  const mine = await tch.get(`/my-scans?date=${date}`);
  assert.strictEqual(mine.status, 200);
  assert.match(mine.text, new RegExp(inAt.slice(11, 16)));
  assert.strictEqual((await tch.get(`/sessions/${session.id}/edit`)).status, 302);
  assert.strictEqual((await tch.post(`/sessions/${session.id}`, { status: 'missed', reason: 'x', change_reason: 'x', date, start_time: first.start_time, end_time: first.end_time })).status, 403);
  assert.strictEqual(q('SELECT status FROM class_sessions WHERE id = ?', session.id).status, 'held');
  const typed = await tch.post('/sessions', { assignment_id: slots[slots.length - 1].assignment_id, slot_id: slots[slots.length - 1].id, date, start_time: slots[slots.length - 1].start_time, end_time: slots[slots.length - 1].end_time, status: 'held' });
  assert.match(typed.location || '', /^\/my-scans/, 'hand entry refused once the scanner is in use');

  // 6. A lesson with no scan is recorded as missed; the teacher asks for a correction; the admin approves.
  assert.ok(slots.length > 1, 'demo teacher has several lessons that day');
  {
    const other = slots[1];
    const missed = q('SELECT * FROM class_sessions WHERE slot_id = ? AND date = ?', other.id, date);
    assert.ok(missed && missed.status === 'missed' && missed.source === 'scanner', 'no scan on a finished day = missed');
    await tch.get(`/my-scans?date=${date}`);
    assert.strictEqual((await tch.post('/my-scans/corrections', { slot_id: other.id, date, reason: 'The scanner was off (test)' })).status, 302);
    const req = q('SELECT * FROM scan_corrections WHERE slot_id = ? AND date = ?', other.id, date);
    assert.strictEqual(req.status, 'pending');
    await admin.get(`/admin/scanner/board?date=${date}`);
    assert.strictEqual((await admin.post(`/admin/scanner/corrections/${req.id}`, { decision: 'approved', admin_note: 'Power cut confirmed' })).status, 302);
    const fixed = q('SELECT * FROM class_sessions WHERE slot_id = ? AND date = ?', other.id, date);
    assert.strictEqual(fixed.status, 'held');
    assert.strictEqual(fixed.source, 'correction');
    assert.ok(q("SELECT 1 FROM audit_log WHERE entity = 'scan_lesson' AND action = 'approved'"));
  }

  // 7. A teacher cannot ask about another teacher's lesson.
  const foreign = q('SELECT ts.id FROM timetable_slots ts JOIN teaching_assignments ta ON ta.id = ts.assignment_id WHERE ta.teacher_id != ? LIMIT 1', teacher.id);
  assert.strictEqual((await tch.post('/my-scans/corrections', { slot_id: foreign.id, date, reason: 'x' })).status, 404);

  // 8. The board and set-up pages open for the admin.
  assert.strictEqual((await admin.get(`/admin/scanner/board?date=${date}`)).status, 200);
  assert.strictEqual((await admin.get('/admin/scanner')).status, 200);
});

test('a device tied to one address is refused from any other', async () => {
  ctx.db.get().prepare("INSERT INTO scan_devices (serial, name, status, allowed_ip) VALUES ('LOCKED0001', 'Locked', 'active', '10.9.9.9')").run();
  assert.strictEqual((await device('/iclock/cdata?SN=LOCKED0001')).status, 403);
  assert.strictEqual((await device('/iclock/cdata?SN=LOCKED0001&table=ATTLOG', { method: 'POST', body: '41\t2026-01-05 07:00:00\n' })).status, 403);
});

test('an uploaded USB file adds scans once', async () => {
  const admin = await new Client(ctx.base).login('demo.admin');
  await admin.get('/admin/scanner');
  const body = { log: '99\t2026-01-06 07:28:00\t0\t1\n99\t2026-01-06 08:27:00\t1\t1\n' };
  const first = await admin.post('/admin/scanner/upload', body);
  assert.strictEqual(first.status, 200);
  assert.match(first.text, /2 /);
  await admin.get('/admin/scanner');
  await admin.post('/admin/scanner/upload', body);
  assert.strictEqual(q("SELECT COUNT(*) n FROM scans WHERE pin = '99'").n, 2);
});

test('a teacher cannot open the scanner administration', async () => {
  const tch = await new Client(ctx.base).login('demo.prof.maths');
  for (const p of ['/admin/scanner', '/admin/scanner/board', '/admin/scanner/calendar']) assert.notStrictEqual((await tch.get(p)).status, 200);
  const parent = await new Client(ctx.base).login('demo.parent');
  assert.notStrictEqual((await parent.get('/my-scans')).status, 200);
});

test('the class day calendar shows every class, or one class, for a chosen day', async () => {
  const admin = await new Client(ctx.base).login('demo.admin');
  const all = await admin.get('/admin/scanner/calendar?date=2026-11-23');
  assert.strictEqual(all.status, 200);
  assert.match(all.text, /tg-col/);
  const cls = q('SELECT id FROM classes ORDER BY id LIMIT 1');
  const one = await admin.get(`/admin/scanner/calendar?date=2026-11-23&class=${cls.id}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual((await admin.get('/admin/scanner/calendar?date=nonsense')).status, 200);
});
