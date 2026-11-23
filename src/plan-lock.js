'use strict';
// Who may change a progression sheet (yearly plan), and when.
//
//   draft   The sheet is being written. The administration and the teachers of that subject
//           and level can add, change and delete lessons.
//   locked  "Submit and lock" was pressed. Nobody can change or delete anything, not even the
//           administration, until the administration opens a time-limited edit window: either
//           by approving a teacher's change request, or by reopening the sheet for itself.
//           When the window ends (or the sheet is submitted again) it is locked again.
//
// Every step (creation, each edit, submission, request, approval, refusal) is written to the
// audit log under entity 'plan', so the sheet page can show its full history.
const db = require('./db');

// UTC timestamps in the same format as SQLite's datetime('now').
function nowUtc(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function addHours(hours, from = new Date()) {
  return nowUtc(new Date(from.getTime() + hours * 3600 * 1000));
}

// Does this teacher teach this plan's subject at this plan's section and level?
function teaches(userId, plan) {
  return !!db.get().prepare(`SELECT 1 FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id
    WHERE ta.teacher_id = ? AND ta.subject_id = ? AND c.year_id = ? AND c.section_id = ? AND c.level = ? LIMIT 1`)
    .get(userId, plan.subject_id, plan.year_id, plan.section_id, plan.level);
}

function windowOpen(plan, now = nowUtc()) {
  return !!(plan.edit_until && plan.edit_until > now);
}

/**
 * What this user can do with this plan right now.
 * canEdit: add, change or delete lessons and chapters, import.
 * canSubmit: lock the sheet (first submission, or closing an edit window).
 * canRequest: ask the administration to open a locked sheet.
 */
function state(user, plan, now = nowUtc()) {
  const isAdmin = user.role === 'admin';
  const isTeacher = user.role === 'teacher' && teaches(user.id, plan);
  const open = windowOpen(plan, now);
  const mine = open && plan.edit_user_id === user.id;
  let canEdit = false;
  if (plan.status === 'draft') canEdit = isAdmin || isTeacher;
  else canEdit = mine && (isAdmin || isTeacher);
  const pending = isTeacher
    ? db.get().prepare("SELECT * FROM plan_change_requests WHERE plan_id = ? AND requested_by = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(plan.id, user.id)
    : null;
  return {
    isAdmin,
    isTeacher,
    locked: plan.status === 'locked',
    windowOpen: open,
    windowMine: mine,
    canEdit,
    canSubmit: canEdit,
    canRequest: isTeacher && plan.status === 'locked' && !mine && !pending,
    pending,
  };
}

// Record one step in the plan's history.
function log(planId, action, userId, { before, after, reason } = {}) {
  db.audit({ entity: 'plan', entityId: planId, action, userId, before, after, reason });
}

function history(planId) {
  return db.get().prepare(`SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity = 'plan' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 200`).all(planId)
    .map((h) => ({ ...h, before: h.before_json ? JSON.parse(h.before_json) : null, after: h.after_json ? JSON.parse(h.after_json) : null }));
}

function pendingCount() {
  return db.get().prepare("SELECT COUNT(*) n FROM plan_change_requests WHERE status = 'pending'").get().n;
}

module.exports = { nowUtc, addHours, teaches, windowOpen, state, log, history, pendingCount };
