'use strict';
// School days: Monday to Friday, minus holidays/closures and exam periods during which lessons
// stop. Used to turn "finish this module in 1 to 2 weeks" into dates, and to count how many
// school days a class is behind (an exam week does not make a teacher late).
const db = require('./db');
const { addDays, weekday, eachDate } = require('./util');

// Durations a teacher can pick for a lesson/module, in school days: [min, max].
const DURATIONS = {
  '1d': [1, 1], '2d': [2, 2], '3d': [3, 3], '2-3d': [2, 3], '1w': [5, 5], '1-2w': [5, 10],
  '2w': [10, 10], '2-3w': [10, 15], '3w': [15, 15], '4w': [20, 20],
};

function durationKey(min, max) {
  if (min == null) return '';
  const k = Object.keys(DURATIONS).find((x) => DURATIONS[x][0] === min && DURATIONS[x][1] === (max == null ? min : max));
  return k || '';
}

// Exam periods (calendar events of category 'evaluation') for a year.
function examPeriods(yearId) {
  return db.get().prepare("SELECT * FROM school_events WHERE year_id = ? AND category = 'evaluation' ORDER BY start_date, end_date").all(yearId);
}

/** Calendar of one school year: which days are school days and why the others are not. */
function calendar(yearId) {
  const off = new Map(); // date -> 'closure' | 'exam'
  for (const c of db.get().prepare('SELECT start_date, end_date FROM closures WHERE year_id = ?').all(yearId)) {
    eachDate(c.start_date, c.end_date, (d) => off.set(d, 'closure'));
  }
  for (const e of examPeriods(yearId)) {
    if (!e.pauses_lessons) continue;
    eachDate(e.start_date, e.end_date || e.start_date, (d) => { if (!off.has(d)) off.set(d, 'exam'); });
  }
  const isSchoolDay = (d) => weekday(d) <= 5 && !off.has(d);
  const next = (d) => { let x = d; for (let i = 0; i < 400 && !isSchoolDay(x); i++) x = addDays(x, 1); return x; };
  // The n-th school day starting from `start` (start counts as day 1 if it is a school day).
  const nth = (start, n) => {
    let x = next(start);
    for (let i = 1; i < n; i++) x = next(addDays(x, 1));
    return x;
  };
  // School days after `from` up to and including `to`.
  const between = (from, to) => {
    let n = 0;
    if (!from || !to || to <= from) return 0;
    eachDate(addDays(from, 1), to, (d) => { if (isSchoolDay(d)) n++; });
    return n;
  };
  return { off, isSchoolDay, next, nth, between, reason: (d) => (weekday(d) > 5 ? 'weekend' : off.get(d) || null) };
}

/**
 * Works out start and finish dates for the lessons of a plan, in order, from their durations.
 * Each chapter starts no earlier than the start of its term. A lesson without a duration keeps
 * its own date and the next lesson starts after it. Only lessons accepted by `canChange(chapter, lesson)` move.
 * Returns the list of changed lessons [{ id, before, after }].
 */
function schedulePlan(plan, canChange) {
  const d = db.get();
  const cal = calendar(plan.year_id);
  const terms = new Map(d.prepare('SELECT * FROM terms WHERE year_id = ?').all(plan.year_id).map((t) => [t.id, t]));
  const year = d.prepare('SELECT * FROM academic_years WHERE id = ?').get(plan.year_id);
  const chapters = d.prepare('SELECT * FROM plan_chapters WHERE plan_id = ? ORDER BY ordinal').all(plan.id);
  const lessonsOf = d.prepare('SELECT * FROM plan_lessons WHERE chapter_id = ? ORDER BY ordinal');
  const upd = d.prepare('UPDATE plan_lessons SET start_date = ?, planned_date = ? WHERE id = ?');
  const changed = [];
  let cursor = year.start_date;
  for (const ch of chapters) {
    const term = ch.term_id && terms.get(ch.term_id);
    if (term && term.start_date > cursor) cursor = term.start_date;
    for (const l of lessonsOf.all(ch.id)) {
      if (!l.duration_days || !canChange(ch, l)) {
        if (l.planned_date && l.planned_date >= cursor) cursor = addDays(l.planned_date, 1);
        continue;
      }
      const start = cal.next(cursor);
      const end = cal.nth(start, Math.max(1, Math.round(l.duration_max_days || l.duration_days)));
      if (start !== l.start_date || end !== l.planned_date) {
        upd.run(start, end, l.id);
        changed.push({ id: l.id, title: l.title, before: { start_date: l.start_date, planned_date: l.planned_date }, after: { start_date: start, planned_date: end } });
      }
      cursor = addDays(end, 1);
    }
  }
  return changed;
}

module.exports = { DURATIONS, durationKey, examPeriods, calendar, schedulePlan };
