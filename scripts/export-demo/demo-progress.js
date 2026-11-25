#!/usr/bin/env node
// Demo preview only: fills in fictional lesson progress for the classes imported from the
// school's timetable, so the curriculum tracker shows a realistic mix (most classes on time,
// some behind, a few far behind) instead of "nothing recorded yet" everywhere.
// Runs on the throw-away demo database built by scripts/export-demo.js; never on a real school.
'use strict';
const db = require('../../src/db');
const { todayIn, addDays } = require('../../src/util');

db.open();
const d = db.get();
const today = todayIn('Africa/Douala');
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const asg = d.prepare(`SELECT ta.*, c.section_id, c.level, c.year_id FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id
  WHERE NOT EXISTS (SELECT 1 FROM progress_entries pe WHERE pe.assignment_id = ta.id)`).all();
const lessonsFor = d.prepare(`SELECT l.* FROM plan_lessons l JOIN plan_chapters ch ON ch.id = l.chapter_id JOIN plans p ON p.id = ch.plan_id
  WHERE p.year_id = ? AND p.section_id = ? AND p.level = ? AND p.subject_id = ? AND l.planned_date IS NOT NULL ORDER BY ch.ordinal, l.ordinal`);
const ins = d.prepare("INSERT INTO progress_entries (assignment_id, lesson_id, date, status, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?)");
let n = 0;
d.transaction(() => {
  for (const a of asg) {
    const r = rand();
    const lagDays = r < 0.65 ? 0 : r < 0.88 ? 14 : 35; // on time, behind, far behind
    const upTo = addDays(today, -lagDays - 1);
    const lessons = lessonsFor.all(a.year_id, a.section_id, a.level, a.subject_id);
    for (const l of lessons) {
      if (l.planned_date > upTo) break;
      ins.run(a.id, l.id, l.planned_date > upTo ? upTo : addDays(l.planned_date, 2) > upTo ? upTo : addDays(l.planned_date, 2), 'completed', null, a.teacher_id);
      n++;
    }
  }
})();
db.close();
console.log(`Demo progress: ${n} lessons marked as done.`);
