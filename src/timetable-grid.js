'use strict';
// Turns a list of timetable slots into a week grid: one column per school day, one row per
// period of the bell schedule, with breaks shown between periods. A lesson that lasts several
// periods (a double period) becomes one cell spanning those rows.
const { minutesBetween } = require('./util');

// Periods come from the school's bell schedule (saved by the data import). Without one, the
// distinct start/end times of the slots themselves are used.
function periodsFor(slots, bellSchedule) {
  if (Array.isArray(bellSchedule) && bellSchedule.length) {
    const used = bellSchedule.filter((p) => p.n !== 0 || slots.some((s) => s.start_time < p.end && s.end_time > p.start));
    return used.map((p) => ({ start: p.start, end: p.end }));
  }
  const cuts = new Set();
  slots.forEach((s) => { cuts.add(s.start_time); cuts.add(s.end_time); });
  const times = [...cuts].sort();
  const out = [];
  for (let i = 0; i + 1 < times.length; i++) {
    if (slots.some((s) => s.start_time < times[i + 1] && s.end_time > times[i])) out.push({ start: times[i], end: times[i + 1] });
  }
  return out;
}

function build(slots, bellSchedule) {
  if (!slots.length) return null;
  const periods = periodsFor(slots, bellSchedule);
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d <= 5 || slots.some((s) => s.day_of_week === d));
  // rows: periods, with a break row wherever two periods do not touch.
  const rows = [];
  periods.forEach((p, i) => {
    const prev = periods[i - 1];
    if (prev && prev.end < p.start) rows.push({ type: 'break', start: prev.end, end: p.start, minutes: minutesBetween(prev.end, p.start) });
    rows.push({ type: 'period', start: p.start, end: p.end, cells: {} });
  });
  const periodRows = rows.filter((r) => r.type === 'period');
  for (const d of days) {
    let open = null; // the cell being extended downwards
    rows.forEach((r) => {
      if (r.type !== 'period') { open = null; return; }
      const here = slots.filter((s) => s.day_of_week === d && s.start_time < r.end && s.end_time > r.start);
      const key = here.map((s) => s.id).sort().join(',');
      if (open && key && open.key === key) { open.span++; r.cells[d] = { covered: true }; return; }
      open = { key, span: 1, slots: here };
      r.cells[d] = open;
    });
  }
  return { days, rows, periods: periodRows.length };
}

module.exports = { build };
