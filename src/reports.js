'use strict';
// Calculations for teaching hours and lesson progress. Kept separate from routes so they
// can be tested and reused by printable views and CSV exports.
const db = require('./db');
const { minutesBetween, weekday, eachDate } = require('./util');

function closedDates(yearId) {
  const set = new Set();
  for (const c of db.get().prepare('SELECT start_date, end_date FROM closures WHERE year_id = ?').all(yearId)) {
    eachDate(c.start_date, c.end_date, (d) => set.add(d));
  }
  return set;
}

// Every scheduled occurrence of a timetable slot between two dates (inclusive), skipping closures.
function slotOccurrences(slot, from, to, closed) {
  const out = [];
  const start = from > slot.term_start ? from : slot.term_start;
  const end = to < slot.term_end ? to : slot.term_end;
  if (start > end) return out;
  eachDate(start, end, (d) => { if (weekday(d) === slot.day_of_week && !closed.has(d)) out.push(d); });
  return out;
}

/**
 * Teaching-hours summary. Scheduled hours come from the timetable (minus closures) up to
 * `asOf`; held/missed/cancelled/make-up come from recorded class sessions.
 * Filters: yearId (required), termId, teacherId, classId, subjectId.
 */
function hoursSummary({ yearId, termId, teacherId, classId, subjectId, asOf }) {
  const closed = closedDates(yearId);
  const where = ['c.year_id = @yearId'];
  if (teacherId) where.push('ta.teacher_id = @teacherId');
  if (classId) where.push('ta.class_id = @classId');
  if (subjectId) where.push('ta.subject_id = @subjectId');
  const params = { yearId, termId, teacherId, classId, subjectId };

  const assignments = db.get().prepare(`SELECT ta.id, ta.teacher_id, ta.class_id, ta.subject_id, u.full_name AS teacher_name,
      c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
    JOIN users u ON u.id = ta.teacher_id WHERE ${where.join(' AND ')} ORDER BY u.full_name, c.name, s.name_en`).all(params);

  const term = termId ? db.get().prepare('SELECT * FROM terms WHERE id = ?').get(termId) : null;
  const year = db.get().prepare('SELECT * FROM academic_years WHERE id = ?').get(yearId);
  const from = term ? term.start_date : year.start_date;
  const to = [term ? term.end_date : year.end_date, asOf].filter(Boolean).sort()[0];

  const slotStmt = db.get().prepare(`SELECT ts.*, t.start_date AS term_start, t.end_date AS term_end FROM timetable_slots ts
    JOIN terms t ON t.id = ts.term_id WHERE ts.assignment_id = ? ${termId ? 'AND ts.term_id = ?' : ''}`);
  const sessStmt = db.get().prepare(`SELECT * FROM class_sessions WHERE assignment_id = ? AND date BETWEEN ? AND ?`);

  const rows = assignments.map((a) => {
    const slots = termId ? slotStmt.all(a.id, termId) : slotStmt.all(a.id);
    let scheduledMin = 0;
    let scheduledCount = 0;
    const scheduledKeys = new Set();
    for (const s of slots) {
      for (const d of slotOccurrences(s, from, to, closed)) {
        scheduledMin += minutesBetween(s.start_time, s.end_time);
        scheduledCount++;
        scheduledKeys.add(`${s.id}|${d}`);
      }
    }
    const sessions = sessStmt.all(a.id, from, to);
    const m = { held: 0, missed: 0, cancelled: 0, makeup: 0 };
    let recordedScheduled = 0;
    let makeupPending = 0;
    for (const s of sessions) {
      m[s.status] += minutesBetween(s.start_time, s.end_time);
      if (s.slot_id && scheduledKeys.has(`${s.slot_id}|${s.date}`)) recordedScheduled++;
      if ((s.status === 'missed' || s.status === 'cancelled') && s.makeup_status === 'planned') makeupPending++;
    }
    const h = (min) => Math.round((min / 60) * 10) / 10;
    return {
      ...a,
      scheduled: h(scheduledMin),
      held: h(m.held),
      missed: h(m.missed),
      cancelled: h(m.cancelled),
      makeup: h(m.makeup),
      delivered: h(m.held + m.makeup),
      notRecorded: scheduledCount - recordedScheduled,
      makeupPending,
      rate: scheduledMin ? Math.round(((m.held + m.makeup) / scheduledMin) * 100) : null,
    };
  });
  return { rows, from, to };
}

/**
 * Planned versus actual progress for one teaching assignment as of a date.
 * Planned position = last lesson whose planned_date is on or before the date.
 * Actual position = last lesson (in plan order) marked completed or in progress by that date.
 */
function progressFor(a, asOf) {
  const plan = db.get().prepare(`SELECT * FROM plans WHERE year_id = ? AND section_id = ? AND level = ? AND subject_id = ?`)
    .get(a.year_id, a.section_id, a.level, a.subject_id);
  if (!plan) return { plan: null, lessons: [], chapters: [] };
  const chapters = db.get().prepare('SELECT * FROM plan_chapters WHERE plan_id = ? ORDER BY ordinal').all(plan.id);
  const lessons = db.get().prepare(`SELECT l.*, ch.title AS chapter_title, ch.ordinal AS chapter_ordinal FROM plan_lessons l
    JOIN plan_chapters ch ON ch.id = l.chapter_id WHERE ch.plan_id = ? ORDER BY ch.ordinal, l.ordinal`).all(plan.id);
  const latest = db.get().prepare(`SELECT p.* FROM progress_entries p WHERE p.assignment_id = ? AND p.date <= ?
    AND p.id = (SELECT p2.id FROM progress_entries p2 WHERE p2.assignment_id = p.assignment_id AND p2.lesson_id = p.lesson_id
      AND p2.date <= ? ORDER BY p2.date DESC, p2.id DESC LIMIT 1)`).all(a.id, asOf, asOf);
  const byLesson = new Map(latest.map((p) => [p.lesson_id, p]));

  let plannedIndex = -1;
  let actualIndex = -1;
  let completed = 0;
  lessons.forEach((l, i) => {
    l.progress = byLesson.get(l.id) || null;
    l.isLate = !!(l.planned_date && l.planned_date <= asOf && (!l.progress || l.progress.status !== 'completed'));
    if (l.planned_date && l.planned_date <= asOf) plannedIndex = i;
    if (l.progress && (l.progress.status === 'completed' || l.progress.status === 'in_progress')) actualIndex = i;
    if (l.progress && l.progress.status === 'completed') completed++;
  });
  const plannedToDate = plannedIndex + 1;
  return {
    plan,
    chapters,
    lessons,
    total: lessons.length,
    completed,
    plannedToDate,
    plannedLesson: plannedIndex >= 0 ? lessons[plannedIndex] : null,
    actualLesson: actualIndex >= 0 ? lessons[actualIndex] : null,
    gap: completed - plannedToDate, // negative = behind the plan
    pct: lessons.length ? Math.round((completed / lessons.length) * 100) : 0,
    plannedPct: lessons.length ? Math.round((plannedToDate / lessons.length) * 100) : 0,
  };
}

// Students with repeated absences or lateness in the last `days` days.
function repeatedAbsences({ yearId, threshold, days, asOf, classId }) {
  const fromDate = new Date(`${asOf}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
  const from = fromDate.toISOString().slice(0, 10);
  return db.get().prepare(`SELECT st.id, st.full_name, st.student_number, c.id AS class_id, c.name AS class_name,
      SUM(ar.status = 'absent') AS absent, SUM(ar.status = 'late') AS late, SUM(ar.status = 'excused') AS excused,
      MAX(CASE WHEN ar.status IN ('absent','late') THEN ar.date END) AS last_date
    FROM attendance_records ar JOIN students st ON st.id = ar.student_id JOIN classes c ON c.id = ar.class_id
    WHERE c.year_id = @yearId AND ar.date BETWEEN @from AND @asOf ${classId ? 'AND c.id = @classId' : ''}
    GROUP BY st.id, c.id HAVING (absent + late) >= @threshold ORDER BY (absent + late) DESC, st.full_name`)
    .all({ yearId, from, asOf, threshold, classId });
}

module.exports = { hoursSummary, progressFor, repeatedAbsences, slotOccurrences, closedDates };
