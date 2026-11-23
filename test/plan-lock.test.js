'use strict';
// Progression sheets are locked once submitted; only an administration-approved, time-limited
// window lets anyone change them, and every step is kept in the history. The curriculum tracker
// flags classes behind their sheet.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { seededDb, startApp, Client } = require('./helpers');

let ctx; let dbInfo;
before(async () => { dbInfo = seededDb(); ctx = await startApp(dbInfo.file); });
after(() => { ctx.server.close(); fs.rmSync(dbInfo.tmp, { recursive: true, force: true }); });

const q = (sql, ...a) => ctx.db.get().prepare(sql).get(...a);
const run = (sql, ...a) => ctx.db.get().prepare(sql).run(...a);
const planId = (title) => q('SELECT id FROM plans WHERE title = ?', title).id;
const firstLesson = (pid) => q('SELECT l.* FROM plan_lessons l JOIN plan_chapters c ON c.id = l.chapter_id WHERE c.plan_id = ? ORDER BY c.ordinal, l.ordinal LIMIT 1', pid);

test('a locked sheet cannot be changed or deleted by its teacher, nor by the administration without opening it', async () => {
  const pid = planId('Mathématiques — Seconde C (exemple)');
  const l = firstLesson(pid);
  const lessons = q('SELECT COUNT(*) n FROM plan_lessons l JOIN plan_chapters c ON c.id = l.chapter_id WHERE c.plan_id = ?', pid).n;
  for (const user of ['demo.prof.maths', 'demo.admin']) {
    const c = await new Client(ctx.base).login(user);
    await c.get(`/plans/${pid}`);
    await c.post(`/plans/lessons/${l.id}`, { title: 'Changed', planned_date: '2027-05-05' });
    await c.post(`/plans/lessons/${l.id}/delete`);
    await c.post(`/plans/chapters/${l.chapter_id}/delete`);
    await c.post(`/plans/${pid}/chapters`, { title: 'New chapter' });
    await c.post(`/plans/${pid}/import`, { csv: 'Ch Z,Leçon Z,01/03/2027' });
  }
  assert.deepStrictEqual(firstLesson(pid), l);
  assert.strictEqual(q('SELECT COUNT(*) n FROM plan_lessons l JOIN plan_chapters c ON c.id = l.chapter_id WHERE c.plan_id = ?', pid).n, lessons);
});

test('a teacher drafts the sheet for a subject they teach, then submitting locks it', async () => {
  const c = await new Client(ctx.base).login('demo.prof.maths');
  const page = await c.get('/plans');
  assert.match(page.text, /Mes fiches de progression|My progression sheets/);
  const pid = planId('Physique-Chimie — Seconde C (brouillon, exemple)');
  await c.get(`/plans/${pid}`);
  const ch = q('SELECT id FROM plan_chapters WHERE plan_id = ? ORDER BY ordinal LIMIT 1', pid).id;
  assert.strictEqual((await c.post(`/plans/chapters/${ch}/lessons`, { title: 'Leçon 1.3', planned_date: '2026-09-28', planned_hours: '2' })).status, 302);
  assert.ok(q("SELECT 1 FROM plan_lessons WHERE chapter_id = ? AND title = 'Leçon 1.3'", ch));
  await c.post(`/plans/${pid}/submit`);
  const p = q('SELECT * FROM plans WHERE id = ?', pid);
  assert.strictEqual(p.status, 'locked');
  assert.ok(p.submitted_at);
  await c.get(`/plans/${pid}`);
  await c.post(`/plans/chapters/${ch}/lessons`, { title: 'Too late', planned_date: '2026-10-05' });
  assert.ok(!q("SELECT 1 FROM plan_lessons WHERE title = 'Too late'"));
  const hist = ctx.db.get().prepare("SELECT action FROM audit_log WHERE entity = 'plan' AND entity_id = ? ORDER BY id").all(pid).map((h) => h.action);
  assert.ok(hist.includes('lesson_added') && hist.includes('submitted'));
});

test('a teacher cannot start a sheet for a subject they do not teach', async () => {
  const c = await new Client(ctx.base).login('demo.prof.maths');
  await c.get('/plans');
  const sec = q("SELECT id FROM sections WHERE code = 'ANG'").id;
  const eng = q("SELECT id FROM subjects WHERE name_en LIKE 'English%'").id;
  const before = q('SELECT COUNT(*) n FROM plans').n;
  const r = await c.post('/plans', { section_id: sec, level: 'Form 4', subject_id: eng });
  assert.ok([400, 403].includes(r.status), String(r.status));
  assert.strictEqual(q('SELECT COUNT(*) n FROM plans').n, before);
});

test('change request: approved by the administration, changes recorded, locked again', async () => {
  const pid = planId('Mathématiques — Seconde C (exemple)');
  const l = firstLesson(pid);
  const t = await new Client(ctx.base).login('demo.prof.maths');
  const other = await new Client(ctx.base).login('demo.prof.lettres');
  const admin = await new Client(ctx.base).login('demo.admin');
  await t.get(`/plans/${pid}`);
  await t.post(`/plans/${pid}/requests`, { reason: 'x' }); // too short
  assert.ok(!q("SELECT 1 FROM plan_change_requests WHERE plan_id = ? AND status = 'pending'", pid));
  await t.post(`/plans/${pid}/requests`, { reason: 'Lesson 1.1 moved after the exams' });
  const rq = q("SELECT * FROM plan_change_requests WHERE plan_id = ? AND status = 'pending'", pid);
  assert.ok(rq);
  // Still locked while waiting.
  await t.post(`/plans/lessons/${l.id}`, { title: 'Early', planned_date: l.planned_date });
  assert.strictEqual(firstLesson(pid).title, l.title);
  // The administration sees it and approves for 24 hours.
  assert.match((await admin.get('/plans/requests')).text, /Lesson 1.1 moved after the exams/);
  await admin.post(`/plans/requests/${rq.id}/approve`, { hours: '24' });
  assert.strictEqual(q('SELECT status FROM plan_change_requests WHERE id = ?', rq.id).status, 'approved');
  // Only the requesting teacher may change it.
  await other.get(`/plans/${pid}`);
  await other.post(`/plans/lessons/${l.id}`, { title: 'Someone else', planned_date: l.planned_date });
  assert.strictEqual(firstLesson(pid).title, l.title);
  await t.get(`/plans/${pid}`);
  await t.post(`/plans/lessons/${l.id}`, { title: 'Leçon 1.1 (déplacée)', planned_date: '2026-12-14', planned_hours: '2' });
  assert.strictEqual(firstLesson(pid).title, 'Leçon 1.1 (déplacée)');
  await t.post(`/plans/${pid}/submit`);
  assert.strictEqual(q('SELECT edit_until FROM plans WHERE id = ?', pid).edit_until, null);
  assert.strictEqual(q('SELECT status FROM plan_change_requests WHERE id = ?', rq.id).status, 'closed');
  await t.post(`/plans/lessons/${l.id}`, { title: 'After lock', planned_date: '2026-12-14' });
  assert.strictEqual(firstLesson(pid).title, 'Leçon 1.1 (déplacée)');
  // The history shows the before and after values.
  const changed = q("SELECT * FROM audit_log WHERE entity = 'plan' AND entity_id = ? AND action = 'lesson_changed' ORDER BY id DESC LIMIT 1", pid);
  assert.strictEqual(JSON.parse(changed.before_json).planned_date, l.planned_date);
  assert.strictEqual(JSON.parse(changed.after_json).planned_date, '2026-12-14');
  const page = await t.get(`/plans/${pid}`);
  assert.match(page.text, /Leçon 1.1 \(déplacée\)/);
  assert.match(page.text, /id="history"/);
});

test('an edit window ends by itself', async () => {
  const pid = planId('Français — Seconde C (exemple)');
  const tid = q("SELECT id FROM users WHERE username = 'demo.prof.lettres'").id;
  run("UPDATE plans SET edit_until = datetime('now', '-1 minute'), edit_user_id = ? WHERE id = ?", tid, pid);
  const l = firstLesson(pid);
  const c = await new Client(ctx.base).login('demo.prof.lettres');
  await c.get(`/plans/${pid}`);
  await c.post(`/plans/lessons/${l.id}`, { title: 'Expired', planned_date: l.planned_date });
  assert.strictEqual(firstLesson(pid).title, l.title);
});

test('refusing a request needs a reason, and only the administration decides', async () => {
  const pid = planId('Mathématiques — Première F3 (exemple)');
  const rq = q("SELECT * FROM plan_change_requests WHERE plan_id = ? AND status = 'pending'", pid);
  const t = await new Client(ctx.base).login('demo.prof.maths');
  await t.get('/plans');
  assert.strictEqual((await t.post(`/plans/requests/${rq.id}/approve`, { hours: '24' })).status, 403);
  const admin = await new Client(ctx.base).login('demo.admin');
  await admin.get('/plans/requests');
  await admin.post(`/plans/requests/${rq.id}/reject`, { note: '' });
  assert.strictEqual(q('SELECT status FROM plan_change_requests WHERE id = ?', rq.id).status, 'pending');
  await admin.post(`/plans/requests/${rq.id}/reject`, { note: 'Use the revision week already planned.' });
  assert.strictEqual(q('SELECT status FROM plan_change_requests WHERE id = ?', rq.id).status, 'rejected');
});

test('the administration can open a locked sheet for itself, with a reason that is kept', async () => {
  const pid = planId('Électrotechnique — Première F3 (exemple)');
  const admin = await new Client(ctx.base).login('demo.admin');
  await admin.get(`/plans/${pid}`);
  await admin.post(`/plans/${pid}/reopen`, { reason: 'Typo in a lesson title' });
  const l = firstLesson(pid);
  await admin.post(`/plans/lessons/${l.id}`, { title: 'Module 1 corrected', planned_date: l.planned_date, planned_hours: String(l.planned_hours) });
  assert.strictEqual(firstLesson(pid).title, 'Module 1 corrected');
  await admin.post(`/plans/${pid}/submit`);
  assert.ok(q("SELECT 1 FROM audit_log WHERE entity = 'plan' AND entity_id = ? AND action = 'reopened' AND reason = 'Typo in a lesson title'", pid));
});

test('curriculum tracker: classes behind are flagged, with how far behind', async () => {
  const reports = require('../src/reports');
  const s = { progress_grace_days: '7', progress_alert_days: '21' };
  const base = { plan: { status: 'locked' }, total: 10, gap: 0, daysBehind: 0 };
  assert.strictEqual(reports.curriculumStatus({ ...base, daysBehind: 3 }, s), 'on_track');
  assert.strictEqual(reports.curriculumStatus({ ...base, daysBehind: 10 }, s), 'behind');
  assert.strictEqual(reports.curriculumStatus({ ...base, daysBehind: 30 }, s), 'far_behind');
  assert.strictEqual(reports.curriculumStatus({ ...base, gap: 2 }, s), 'ahead');
  assert.strictEqual(reports.curriculumStatus({ ...base, plan: { status: 'draft' } }, s), 'not_submitted');
  assert.strictEqual(reports.curriculumStatus({ plan: null, total: 0 }, s), 'no_plan');

  const admin = await new Client(ctx.base).login('demo.admin');
  const late = await admin.get('/progress?state=late');
  assert.strictEqual(late.status, 200);
  assert.match(late.text, /Form 4 A/); // the seeded English class with four weeks without progress
  assert.match(late.text, /Fort retard|Far behind/);
  const now = await admin.get('/progress/now?date=2026-11-24&time=08:00');
  assert.strictEqual(now.status, 200);
  assert.match(now.text, /2nde C/);
  const teacher = await new Client(ctx.base).login('demo.prof.maths');
  assert.strictEqual((await teacher.get('/progress/now')).status, 403);
  const mine = await teacher.get('/progress');
  assert.strictEqual(mine.status, 200);
  assert.doesNotMatch(mine.text, /Teacher-English/);
});
