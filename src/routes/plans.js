'use strict';
// Yearly plans (progression sheets) by section, level and subject: chapters and lessons.
// Nothing about the national curriculum is hard-coded: the school enters or imports it.
//
// Teachers write the sheet for a subject they teach, then "Submit and lock" it. A locked sheet
// cannot be changed or deleted by anyone until the administration opens a time-limited edit
// window (see src/plan-lock.js). Every step is kept in the sheet's history.
const express = require('express');
const { groupPlans } = require('../class-groups');
const db = require('../db');
const auth = require('../auth');
const lock = require('../plan-lock');
const days = require('../school-days');
const { Validator, int, str, isDate, parseCsv } = require('../util');

const r = express.Router();
// Router-level guard (defence in depth): every path below also checks its role itself, and
// every change checks the sheet's lock state (lock.state).
r.use('/plans', auth.requireRole('admin', 'teacher'));

function lists(yearId) {
  return {
    sections: db.get().prepare('SELECT * FROM sections ORDER BY id').all(),
    subjects: db.get().prepare('SELECT * FROM subjects WHERE active = 1 ORDER BY name_en').all(),
    levels: db.get().prepare('SELECT DISTINCT section_id, level FROM classes WHERE year_id = ? ORDER BY level').all(yearId),
    terms: db.get().prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(yearId),
  };
}

// The subjects and levels a teacher teaches this year, with their sheet if there is one.
function teacherSheets(userId, yearId) {
  return db.get().prepare(`SELECT DISTINCT c.section_id, c.level, ta.subject_id, se.name_en AS section_en, se.name_fr AS section_fr,
      s.name_en AS subject_en, s.name_fr AS subject_fr, p.id AS plan_id, p.status, p.edit_until, p.edit_user_id,
      (SELECT COUNT(*) FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = p.id) AS lessons,
      (SELECT COUNT(*) FROM plan_change_requests pr WHERE pr.plan_id = p.id AND pr.requested_by = @uid AND pr.status = 'pending') AS pending
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN sections se ON se.id = c.section_id JOIN subjects s ON s.id = ta.subject_id
    LEFT JOIN plans p ON p.year_id = c.year_id AND p.section_id = c.section_id AND p.level = c.level AND p.subject_id = ta.subject_id
    WHERE ta.teacher_id = @uid AND c.year_id = @year ORDER BY c.level, s.name_fr`).all({ uid: userId, year: yearId })
    .map((x) => ({ ...x, windowOpen: x.edit_until && x.edit_until > lock.nowUtc() && x.edit_user_id === userId }));
}

function renderList(req, res, { errors = [], values = {}, status = 200 } = {}) {
  const year = res.locals.year;
  const sectionId = int(req.query.section);
  const rows = db.get().prepare(`SELECT p.*, se.code AS section_code, se.name_en AS section_en, se.name_fr AS section_fr, s.name_en AS subject_en, s.name_fr AS subject_fr,
      (SELECT COUNT(*) FROM plan_chapters ch WHERE ch.plan_id = p.id) AS chapters,
      (SELECT COUNT(*) FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = p.id) AS lessons
    FROM plans p JOIN sections se ON se.id = p.section_id JOIN subjects s ON s.id = p.subject_id
    WHERE p.year_id = ? AND (? IS NULL OR p.section_id = ?) ORDER BY CASE se.code WHEN 'ANG' THEN 1 WHEN 'GEN' THEN 2 WHEN 'TECH' THEN 3 ELSE 4 END, se.id, p.level, s.name_fr`).all(year.id, sectionId, sectionId);
  const mine = req.user.role === 'teacher' ? teacherSheets(req.user.id, year.id) : [];
  const pendingRequests = req.user.role === 'admin' ? lock.pendingCount() : 0;
  res.status(status).render('plans/list', { title: req.t('plans.title'), lockNow: lock.nowUtc(), openTerms: lock.openTerms(year.id, res.locals.today), windowsLimited: lock.windowsDefined(year.id), rows, groups: groupPlans(rows), sectionId, mine, pendingRequests, ...lists(year.id), errors, values });
}

r.get('/plans', auth.requireRole('admin', 'teacher'), (req, res) => {
  if (!res.locals.year) return res.redirect('/');
  renderList(req, res);
});

// A new sheet starts as a draft. Teachers may only start one for a subject and level they teach.
r.post('/plans', auth.requireRole('admin', 'teacher'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/');
  const values = { section_id: int(req.body.section_id), level: str(req.body.level, 60), subject_id: int(req.body.subject_id), title: str(req.body.title, 200) };
  const v = new Validator().required(values.section_id, 'section_id').required(values.level, 'level').required(values.subject_id, 'subject_id');
  if (v.ok && req.user.role === 'teacher' && !lock.teaches(req.user.id, { ...values, year_id: year.id })) return auth.forbidden(req, res);
  if (v.ok && req.user.role === 'teacher' && lock.windowsDefined(year.id) && !lock.openTerms(year.id, res.locals.today).length) {
    res.flash('error', 'plans.win.closedNow');
    return res.redirect('/plans');
  }
  if (v.ok && db.get().prepare('SELECT 1 FROM plans WHERE year_id = ? AND section_id = ? AND level = ? AND subject_id = ?').get(year.id, values.section_id, values.level, values.subject_id)) {
    v.errors.push({ field: 'level', key: 'plans.exists' });
  }
  const subj = v.ok && db.get().prepare('SELECT * FROM subjects WHERE id = ?').get(values.subject_id);
  if (v.ok && !subj) v.errors.push({ field: 'subject_id', key: 'validation.choice' });
  if (!v.ok) return renderList(req, res, { errors: v.errors, values, status: 400 });
  const info = db.get().prepare("INSERT INTO plans (year_id, section_id, level, subject_id, title, created_by, status) VALUES (?, ?, ?, ?, ?, ?, 'draft')")
    .run(year.id, values.section_id, values.level, values.subject_id, values.title || `${subj.name_fr} / ${subj.name_en} — ${values.level}`, req.user.id);
  lock.log(Number(info.lastInsertRowid), 'create', req.user.id, { after: values });
  res.flash('ok', 'plans.created');
  res.redirect(`/plans/${info.lastInsertRowid}`);
});

/* ---------- Change requests (administration) ---------- */

function loadRequest(id) {
  return db.get().prepare(`SELECT pr.*, u.full_name AS requester, p.title AS plan_title, p.edit_until, p.edit_user_id, p.status AS plan_status, d.full_name AS decider
    FROM plan_change_requests pr JOIN plans p ON p.id = pr.plan_id JOIN users u ON u.id = pr.requested_by LEFT JOIN users d ON d.id = pr.decided_by
    WHERE pr.id = ?`).get(id);
}

r.get('/plans/requests', auth.requireRole('admin'), (req, res) => {
  const base = `SELECT pr.*, u.full_name AS requester, p.title AS plan_title, p.level, p.edit_until, p.edit_user_id, d.full_name AS decider
    FROM plan_change_requests pr JOIN plans p ON p.id = pr.plan_id JOIN users u ON u.id = pr.requested_by LEFT JOIN users d ON d.id = pr.decided_by`;
  const pending = db.get().prepare(`${base} WHERE pr.status = 'pending' ORDER BY pr.created_at, pr.id`).all();
  const recent = db.get().prepare(`${base} WHERE pr.status != 'pending' ORDER BY COALESCE(pr.decided_at, pr.created_at) DESC, pr.id DESC LIMIT 50`).all();
  res.render('plans/requests', { title: req.t('plans.requestsTitle'), pending, recent, now: lock.nowUtc(), windowHours: Number(db.getSettings().plan_edit_window_hours) || 48 });
});

r.post('/plans/requests/:rid/approve', auth.requireRole('admin'), (req, res) => {
  const rq = loadRequest(int(req.params.rid));
  if (!rq) return auth.notFound(req, res);
  if (rq.status !== 'pending') { res.flash('error', 'plans.requestDone'); return res.redirect('/plans/requests'); }
  const hours = int(req.body.hours) || Number(db.getSettings().plan_edit_window_hours) || 48;
  if (hours < 1 || hours > 336) { res.flash('error', 'validation.checkFields'); return res.redirect('/plans/requests'); }
  if (rq.edit_until && rq.edit_until > lock.nowUtc() && rq.edit_user_id !== rq.requested_by) {
    res.flash('error', 'plans.windowBusy'); return res.redirect('/plans/requests');
  }
  const note = str(req.body.note, 1000) || null;
  const until = lock.addHours(hours);
  db.get().transaction(() => {
    db.get().prepare("UPDATE plan_change_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ?, window_hours = ? WHERE id = ?")
      .run(req.user.id, note, hours, rq.id);
    db.get().prepare('UPDATE plans SET edit_until = ?, edit_user_id = ? WHERE id = ?').run(until, rq.requested_by, rq.plan_id);
    lock.log(rq.plan_id, 'request_approved', req.user.id, { reason: note, after: { request_id: rq.id, teacher: rq.requester, until, hours } });
  })();
  res.flash('ok', 'plans.requestApproved');
  res.redirect('/plans/requests');
});

r.post('/plans/requests/:rid/reject', auth.requireRole('admin'), (req, res) => {
  const rq = loadRequest(int(req.params.rid));
  if (!rq) return auth.notFound(req, res);
  if (rq.status !== 'pending') { res.flash('error', 'plans.requestDone'); return res.redirect('/plans/requests'); }
  const note = str(req.body.note, 1000);
  if (!note) { res.flash('error', 'plans.rejectNeedsNote'); return res.redirect('/plans/requests'); }
  db.get().transaction(() => {
    db.get().prepare("UPDATE plan_change_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").run(req.user.id, note, rq.id);
    lock.log(rq.plan_id, 'request_rejected', req.user.id, { reason: note, after: { request_id: rq.id, teacher: rq.requester } });
  })();
  res.flash('ok', 'plans.requestRejected');
  res.redirect('/plans/requests');
});

/* ---------- One sheet ---------- */

function loadPlan(id) {
  return db.get().prepare(`SELECT p.*, se.name_en AS section_en, se.name_fr AS section_fr, s.name_en AS subject_en, s.name_fr AS subject_fr,
      sb.full_name AS submitted_name, eu.full_name AS edit_user_name, cu.full_name AS created_name
    FROM plans p JOIN sections se ON se.id = p.section_id JOIN subjects s ON s.id = p.subject_id
    LEFT JOIN users sb ON sb.id = p.submitted_by LEFT JOIN users eu ON eu.id = p.edit_user_id LEFT JOIN users cu ON cu.id = p.created_by
    WHERE p.id = ?`).get(id);
}

function planContent(planId) {
  const chapters = db.get().prepare('SELECT ch.*, t.name AS term_name FROM plan_chapters ch LEFT JOIN terms t ON t.id = ch.term_id WHERE plan_id = ? ORDER BY ordinal').all(planId);
  const lessonStmt = db.get().prepare(`SELECT l.*, (SELECT COUNT(*) FROM progress_entries pe WHERE pe.lesson_id = l.id) AS used FROM plan_lessons l WHERE chapter_id = ? ORDER BY ordinal`);
  chapters.forEach((ch) => { ch.lessons = lessonStmt.all(ch.id); });
  return chapters;
}

function renderPlan(req, res, plan, { importErrors = [], csv = '', status = 200 } = {}) {
  const view = req.query.print === '1' ? 'plans/print' : 'plans/detail';
  const requests = db.get().prepare(`SELECT pr.*, u.full_name AS requester, d.full_name AS decider FROM plan_change_requests pr
    JOIN users u ON u.id = pr.requested_by LEFT JOIN users d ON d.id = pr.decided_by WHERE pr.plan_id = ? ORDER BY pr.id DESC`).all(plan.id);
  res.status(status).render(view, {
    title: plan.title, plan, chapters: planContent(plan.id), terms: lists(plan.year_id).terms, importErrors, csv,
    durations: Object.keys(days.DURATIONS), durationKey: days.durationKey, exams: days.examPeriods(plan.year_id),
    lockState: stateOf(req, res, plan), history: lock.history(plan.id), requests,
  });
}

function stateOf(req, res, plan) {
  return lock.state(req.user, plan, lock.nowUtc(), res.locals.today);
}

// Loads the plan behind a change and refuses it unless the sheet is open to this user: the whole
// sheet (draft or approved window), or, during a term's upload window, the chapters of that term.
// A lesson that already has recorded progress can only change with the whole sheet open.
function editable(req, res, plan, back, { termId, lesson } = {}) {
  if (!plan) { auth.notFound(req, res); return false; }
  const s = stateOf(req, res, plan);
  if (s.canEdit) return true;
  if (termId !== undefined && s.canEditTerm(termId) && !(lesson && lesson.used)) return true;
  if (!s.isAdmin && !s.isTeacher) { auth.notFound(req, res); return false; }
  res.flash('error', 'plans.lockedNoChange');
  res.redirect(back || `/plans/${plan.id}`);
  return false;
}

r.get('/plans/:id', auth.requireRole('admin', 'teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  renderPlan(req, res, plan);
});

// "Submit and lock": first submission of a draft, or the end of an edit window.
r.post('/plans/:id/submit', auth.requireRole('admin', 'teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const st = stateOf(req, res, plan);
  // During a term's upload window: lock the part of the sheet for that term.
  if (!st.canEdit && st.canSubmitTerms) {
    db.get().transaction(() => {
      const ins = db.get().prepare('INSERT OR IGNORE INTO plan_term_submissions (plan_id, term_id, submitted_by) VALUES (?, ?, ?)');
      st.termIds.forEach((tid) => ins.run(plan.id, tid, req.user.id));
      lock.log(plan.id, 'term_submitted', req.user.id, { after: { terms: st.openTerms.filter((t) => st.termIds.includes(t.id)).map((t) => t.name) } });
    })();
    res.flash('ok', 'plans.termSubmitted');
    return res.redirect(`/plans/${plan.id}`);
  }
  if (!editable(req, res, plan)) return;
  const lessons = db.get().prepare('SELECT COUNT(*) n FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = ?').get(plan.id).n;
  if (!lessons) { res.flash('error', 'plans.submitEmpty'); return res.redirect(`/plans/${plan.id}`); }
  const wasDraft = plan.status === 'draft';
  db.get().transaction(() => {
    if (wasDraft) {
      // Terms whose upload window is open now count as handed in.
      const ins = db.get().prepare('INSERT OR IGNORE INTO plan_term_submissions (plan_id, term_id, submitted_by) VALUES (?, ?, ?)');
      st.openTerms.forEach((t) => ins.run(plan.id, t.id, req.user.id));
      db.get().prepare("UPDATE plans SET status = 'locked', submitted_by = ?, submitted_at = datetime('now'), edit_until = NULL, edit_user_id = NULL WHERE id = ?").run(req.user.id, plan.id);
    } else {
      db.get().prepare('UPDATE plans SET edit_until = NULL, edit_user_id = NULL WHERE id = ?').run(plan.id);
      db.get().prepare("UPDATE plan_change_requests SET status = 'closed', closed_at = datetime('now') WHERE plan_id = ? AND status = 'approved'").run(plan.id);
    }
    lock.log(plan.id, wasDraft ? 'submitted' : 'relocked', req.user.id, { after: { lessons } });
  })();
  res.flash('ok', wasDraft ? 'plans.submitted' : 'plans.relocked');
  res.redirect(`/plans/${plan.id}`);
});

// A teacher asks the administration to open a locked sheet.
r.post('/plans/:id/requests', auth.requireRole('teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const s = stateOf(req, res, plan);
  if (!s.isTeacher) return auth.notFound(req, res);
  if (!s.canRequest) { res.flash('info', s.pending ? 'plans.requestAlready' : 'plans.requestNotNeeded'); return res.redirect(`/plans/${plan.id}`); }
  const reason = str(req.body.reason, 1000);
  if (!reason || reason.length < 5) { res.flash('error', 'plans.requestNeedsReason'); return res.redirect(`/plans/${plan.id}#request`); }
  const info = db.get().prepare('INSERT INTO plan_change_requests (plan_id, requested_by, reason) VALUES (?, ?, ?)').run(plan.id, req.user.id, reason);
  lock.log(plan.id, 'request_sent', req.user.id, { reason, after: { request_id: Number(info.lastInsertRowid) } });
  res.flash('ok', 'plans.requestSent');
  res.redirect(`/plans/${plan.id}`);
});

// The administration opens a locked sheet for itself (the change is still recorded and timed).
r.post('/plans/:id/reopen', auth.requireRole('admin'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const reason = str(req.body.reason, 1000);
  if (plan.status !== 'locked') return res.redirect(`/plans/${plan.id}`);
  if (!reason || reason.length < 5) { res.flash('error', 'plans.requestNeedsReason'); return res.redirect(`/plans/${plan.id}#reopen`); }
  if (lock.windowOpen(plan) && plan.edit_user_id !== req.user.id) { res.flash('error', 'plans.windowBusy'); return res.redirect(`/plans/${plan.id}`); }
  const hours = Number(db.getSettings().plan_edit_window_hours) || 48;
  const until = lock.addHours(hours);
  db.get().prepare('UPDATE plans SET edit_until = ?, edit_user_id = ? WHERE id = ?').run(until, req.user.id, plan.id);
  lock.log(plan.id, 'reopened', req.user.id, { reason, after: { until, hours } });
  res.flash('ok', 'plans.reopened');
  res.redirect(`/plans/${plan.id}`);
});

// The administration closes an edit window early, whoever it was opened for.
r.post('/plans/:id/close-window', auth.requireRole('admin'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  if (plan.edit_until) {
    db.get().transaction(() => {
      db.get().prepare('UPDATE plans SET edit_until = NULL, edit_user_id = NULL WHERE id = ?').run(plan.id);
      db.get().prepare("UPDATE plan_change_requests SET status = 'closed', closed_at = datetime('now') WHERE plan_id = ? AND status = 'approved'").run(plan.id);
      lock.log(plan.id, 'window_closed', req.user.id, { before: { until: plan.edit_until, user: plan.edit_user_name } });
    })();
  }
  res.flash('ok', 'plans.relocked');
  res.redirect(`/plans/${plan.id}`);
});

r.post('/plans/:id/chapters', auth.requireRole('admin', 'teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  const termId = int(req.body.term_id);
  if (!editable(req, res, plan, null, { termId })) return;
  const title = str(req.body.title, 200);
  if (!title) { res.flash('error', 'validation.required'); return res.redirect(`/plans/${plan.id}`); }
  const max = db.get().prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_chapters WHERE plan_id = ?').get(plan.id).m;
  const term = termId && db.get().prepare('SELECT id FROM terms WHERE id = ? AND year_id = ?').get(termId, plan.year_id);
  const info = db.get().prepare('INSERT INTO plan_chapters (plan_id, term_id, ordinal, title) VALUES (?, ?, ?, ?)').run(plan.id, term ? termId : null, max + 1, title);
  lock.log(plan.id, 'chapter_added', req.user.id, { after: { chapter_id: Number(info.lastInsertRowid), title } });
  res.flash('ok', 'common.saved');
  res.redirect(`/plans/${plan.id}#ch-${info.lastInsertRowid}`);
});

function lessonInput(body) {
  const title = str(body.title, 200);
  const plannedDate = str(body.planned_date, 10) || null;
  const hours = body.planned_hours ? Number(String(body.planned_hours).replace(',', '.')) : null;
  const dur = str(body.duration, 10);
  const range = dur ? days.DURATIONS[dur] : null;
  const ok = !!title && (!plannedDate || isDate(plannedDate)) && (hours === null || (hours >= 0 && hours < 500)) && (!dur || !!range);
  return { ok, title, plannedDate, hours, durMin: range ? range[0] : null, durMax: range ? range[1] : null };
}

r.post('/plans/chapters/:cid/lessons', auth.requireRole('admin', 'teacher'), (req, res) => {
  const ch = db.get().prepare('SELECT * FROM plan_chapters WHERE id = ?').get(int(req.params.cid));
  if (!ch) return auth.notFound(req, res);
  const plan = loadPlan(ch.plan_id);
  if (!editable(req, res, plan, `/plans/${ch.plan_id}#ch-${ch.id}`, { termId: ch.term_id })) return;
  const x = lessonInput(req.body);
  if (!x.ok) { res.flash('error', 'validation.checkFields'); return res.redirect(`/plans/${ch.plan_id}#ch-${ch.id}`); }
  const max = db.get().prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_lessons WHERE chapter_id = ?').get(ch.id).m;
  const info = db.get().prepare('INSERT INTO plan_lessons (chapter_id, ordinal, title, planned_date, planned_hours, duration_days, duration_max_days) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ch.id, max + 1, x.title, x.plannedDate, x.hours, x.durMin, x.durMax);
  lock.log(plan.id, 'lesson_added', req.user.id, { after: { lesson_id: Number(info.lastInsertRowid), chapter: ch.title, title: x.title, planned_date: x.plannedDate, planned_hours: x.hours, duration: days.durationKey(x.durMin, x.durMax) || null } });
  res.flash('ok', 'common.saved');
  res.redirect(`/plans/${ch.plan_id}#ch-${ch.id}`);
});

function loadLesson(id) {
  return db.get().prepare(`SELECT l.*, ch.plan_id, ch.term_id, ch.title AS chapter_title,
      (SELECT COUNT(*) FROM progress_entries pe WHERE pe.lesson_id = l.id) AS used
    FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE l.id = ?`).get(id);
}

r.post('/plans/lessons/:lid', auth.requireRole('admin', 'teacher'), (req, res) => {
  const l = loadLesson(int(req.params.lid));
  if (!l) return auth.notFound(req, res);
  const plan = loadPlan(l.plan_id);
  if (!editable(req, res, plan, `/plans/${l.plan_id}#ch-${l.chapter_id}`, { termId: l.term_id, lesson: l })) return;
  const x = lessonInput(req.body);
  if (!x.ok) { res.flash('error', 'validation.checkFields'); return res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`); }
  if (x.title === l.title && x.plannedDate === l.planned_date && x.hours === l.planned_hours && x.durMin === l.duration_days && x.durMax === l.duration_max_days) return res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`);
  db.get().prepare('UPDATE plan_lessons SET title = ?, planned_date = ?, planned_hours = ?, duration_days = ?, duration_max_days = ? WHERE id = ?').run(x.title, x.plannedDate, x.hours, x.durMin, x.durMax, l.id);
  lock.log(plan.id, 'lesson_changed', req.user.id, {
    before: { lesson_id: l.id, title: l.title, planned_date: l.planned_date, planned_hours: l.planned_hours, duration: days.durationKey(l.duration_days, l.duration_max_days) || null },
    after: { lesson_id: l.id, title: x.title, planned_date: x.plannedDate, planned_hours: x.hours, duration: days.durationKey(x.durMin, x.durMax) || null },
  });
  res.flash('ok', 'common.saved');
  res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`);
});

r.post('/plans/lessons/:lid/delete', auth.requireRole('admin', 'teacher'), (req, res) => {
  const l = loadLesson(int(req.params.lid));
  if (!l) return auth.notFound(req, res);
  const plan = loadPlan(l.plan_id);
  if (!editable(req, res, plan, `/plans/${l.plan_id}#ch-${l.chapter_id}`, { termId: l.term_id, lesson: l })) return;
  if (db.get().prepare('SELECT 1 FROM progress_entries WHERE lesson_id = ?').get(l.id)) {
    res.flash('error', 'plans.lessonInUse');
  } else {
    db.get().prepare('DELETE FROM plan_lessons WHERE id = ?').run(l.id);
    lock.log(plan.id, 'lesson_deleted', req.user.id, { before: { lesson_id: l.id, chapter: l.chapter_title, title: l.title, planned_date: l.planned_date, planned_hours: l.planned_hours } });
    res.flash('ok', 'common.deleted');
  }
  res.redirect(`/plans/${l.plan_id}#ch-${l.chapter_id}`);
});

r.post('/plans/chapters/:cid/delete', auth.requireRole('admin', 'teacher'), (req, res) => {
  const ch = db.get().prepare('SELECT * FROM plan_chapters WHERE id = ?').get(int(req.params.cid));
  if (!ch) return auth.notFound(req, res);
  const plan = loadPlan(ch.plan_id);
  if (!editable(req, res, plan, null, { termId: ch.term_id })) return;
  if (db.get().prepare('SELECT 1 FROM progress_entries pe JOIN plan_lessons l ON l.id = pe.lesson_id WHERE l.chapter_id = ?').get(ch.id)) {
    res.flash('error', 'plans.lessonInUse');
  } else {
    const lessons = db.get().prepare('SELECT title, planned_date FROM plan_lessons WHERE chapter_id = ? ORDER BY ordinal').all(ch.id);
    db.get().prepare('DELETE FROM plan_chapters WHERE id = ?').run(ch.id);
    lock.log(plan.id, 'chapter_deleted', req.user.id, { before: { chapter_id: ch.id, title: ch.title, lessons } });
    res.flash('ok', 'common.deleted');
  }
  res.redirect(`/plans/${ch.plan_id}`);
});

// Works out the lesson dates from their durations, skipping weekends, holidays and exam periods.
r.post('/plans/:id/schedule', auth.requireRole('admin', 'teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const st = stateOf(req, res, plan);
  if (!st.canEdit && !st.termIds.length) return editable(req, res, plan);
  const used = new Set(db.get().prepare(`SELECT DISTINCT pe.lesson_id FROM progress_entries pe JOIN plan_lessons l ON l.id = pe.lesson_id
    JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = ?`).all(plan.id).map((x) => x.lesson_id));
  let changed = [];
  db.get().transaction(() => {
    changed = days.schedulePlan(plan, (ch, l) => st.canEditTerm(ch.term_id) && (st.canEdit || !used.has(l.id)));
    if (changed.length) lock.log(plan.id, 'scheduled', req.user.id, { after: { lessons: changed.length, first: changed[0].after.start_date, last: changed[changed.length - 1].after.planned_date } });
  })();
  res.flash(changed.length ? 'ok' : 'info', changed.length ? 'plans.scheduled' : 'plans.scheduleNothing');
  res.redirect(`/plans/${plan.id}`);
});

// Upload windows: for each term, the dates during which teachers may upload or complete their sheet.
r.post('/plans/windows', auth.requireRole('admin'), (req, res) => {
  const year = res.locals.year;
  if (!year) return res.redirect('/plans');
  const terms = db.get().prepare('SELECT * FROM terms WHERE year_id = ? ORDER BY ordinal').all(year.id);
  const next = [];
  for (const t of terms) {
    const a = str(req.body[`start_${t.id}`], 10) || null;
    const b = str(req.body[`end_${t.id}`], 10) || null;
    if ((a && !isDate(a)) || (b && !isDate(b)) || (!a !== !b) || (a && b && a > b)) { res.flash('error', 'plans.win.invalid'); return res.redirect('/plans#windows'); }
    next.push({ t, a, b });
  }
  db.get().transaction(() => {
    const upd = db.get().prepare('UPDATE terms SET plan_window_start = ?, plan_window_end = ? WHERE id = ?');
    for (const { t, a, b } of next) {
      if (t.plan_window_start === a && t.plan_window_end === b) continue;
      upd.run(a, b, t.id);
      db.audit({ entity: 'term', entityId: t.id, action: 'plan_window', userId: req.user.id, before: { start: t.plan_window_start, end: t.plan_window_end }, after: { start: a, end: b } });
    }
  })();
  res.flash('ok', 'common.saved');
  res.redirect('/plans#windows');
});

// Accepts DD/MM/YYYY (common in Cameroon) or YYYY-MM-DD.
function normDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

// CSV import: chapter, lesson, planned date, planned hours, term name (optional). Lines are appended.
r.post('/plans/:id/import', auth.requireRole('admin', 'teacher'), (req, res) => {
  const plan = loadPlan(int(req.params.id));
  if (!plan) return auth.notFound(req, res);
  const st = stateOf(req, res, plan);
  // During a term's upload window only that term's chapters can be added to a locked sheet.
  const termMode = !st.canEdit && st.termIds.length > 0;
  if (!termMode && !editable(req, res, plan)) return;
  const csv = String(req.body.csv || '').slice(0, 200000);
  const rows = parseCsv(csv);
  const terms = lists(plan.year_id).terms;
  const errors = [];
  if (rows.length && /chap/i.test(rows[0][0] || '')) rows.shift(); // header row
  const parsed = rows.map((r0, i) => {
    const [chapter, lesson, date, hours, termName] = r0;
    const planned = normDate(date);
    let term = termName ? terms.find((t) => t.name.toLowerCase() === termName.toLowerCase()) : null;
    if (termMode && !termName) term = terms.find((t) => t.id === st.termIds[0]);
    if (termMode && term && !st.termIds.includes(term.id)) errors.push(req.t('plans.importRowTermClosed', { row: i + 1, term: term.name }));
    if (!chapter || !lesson) errors.push(req.t('plans.importRowMissing', { row: i + 1 }));
    if (planned && !isDate(planned)) errors.push(req.t('plans.importRowDate', { row: i + 1 }));
    if (hours && !(Number(hours.replace(',', '.')) >= 0)) errors.push(req.t('plans.importRowHours', { row: i + 1 }));
    if (termName && !term) errors.push(req.t('plans.importRowTerm', { row: i + 1, term: termName }));
    return { chapter, lesson, planned, hours: hours ? Number(hours.replace(',', '.')) : null, termId: term ? term.id : null };
  });
  if (!rows.length) errors.push(req.t('plans.importEmpty'));
  if (termMode) {
    // Rows may not be added to an existing chapter of a term that is not open.
    const existing = new Map(db.get().prepare('SELECT title, term_id FROM plan_chapters WHERE plan_id = ?').all(plan.id).map((c) => [c.title.toLowerCase(), c.term_id]));
    parsed.forEach((row, i) => {
      if (row.chapter && existing.has(row.chapter.toLowerCase()) && !st.termIds.includes(existing.get(row.chapter.toLowerCase()))) errors.push(req.t('plans.importRowChapterLocked', { row: i + 1 }));
    });
  }
  if (errors.length) return renderPlan(req, res, plan, { importErrors: errors, csv, status: 400 });
  const d = db.get();
  let lessons = 0;
  d.transaction(() => {
    const chapterIds = new Map(d.prepare('SELECT id, title FROM plan_chapters WHERE plan_id = ?').all(plan.id).map((c) => [c.title.toLowerCase(), c.id]));
    for (const row of parsed) {
      let cid = chapterIds.get(row.chapter.toLowerCase());
      if (!cid) {
        const max = d.prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_chapters WHERE plan_id = ?').get(plan.id).m;
        cid = Number(d.prepare('INSERT INTO plan_chapters (plan_id, term_id, ordinal, title) VALUES (?, ?, ?, ?)').run(plan.id, row.termId, max + 1, row.chapter.slice(0, 200)).lastInsertRowid);
        chapterIds.set(row.chapter.toLowerCase(), cid);
      }
      const max = d.prepare('SELECT COALESCE(MAX(ordinal), 0) m FROM plan_lessons WHERE chapter_id = ?').get(cid).m;
      d.prepare('INSERT INTO plan_lessons (chapter_id, ordinal, title, planned_date, planned_hours) VALUES (?, ?, ?, ?, ?)').run(cid, max + 1, row.lesson.slice(0, 200), row.planned, row.hours);
      lessons++;
    }
    lock.log(plan.id, 'imported', req.user.id, { after: { lessons } });
  })();
  res.flash('ok', 'plans.imported');
  res.redirect(`/plans/${plan.id}`);
});

module.exports = r;
