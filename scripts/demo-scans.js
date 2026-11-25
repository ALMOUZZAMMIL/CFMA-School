'use strict';
// Simulated fingerprint scans for the DEMO only (fictional data). Used by the static demo
// export so the class calendar and the scanner pages show a realistic school day:
// most teachers scan out and back on time, a few are late, forget the scan back or never scan.
// Prints the frozen demo clock ("YYYY-MM-DD HH:MM") on the last line of its output.
// Refuses to run on anything but a demo database, and never in production.
require('../src/env');
const path = require('path');

if (process.env.NODE_ENV === 'production') { console.error('Refusing: demo scans are never added in production.'); process.exit(2); }
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'school.db');
const db = require('../src/db');
db.open(dbFile);
const d = db.get();
if (db.getSettings().demo_mode !== '1') { console.error('Refusing: this database is not a demo database.'); process.exit(2); }
const { weekday, addDays, todayIn } = require('../src/util');

// Deterministic "random" numbers, so every build shows the same day.
let seed = 20261123;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const hasLessons = (date) => weekday(date) <= 5
  && !d.prepare('SELECT 1 FROM closures WHERE ? BETWEEN start_date AND end_date').get(date)
  && !!d.prepare(`SELECT 1 FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id
      WHERE ts.day_of_week = ? AND ? BETWEEN t.start_date AND t.end_date LIMIT 1`).get(weekday(date), date);

// The demo "today": the most recent school day, frozen at 10:40 in the morning.
let day = todayIn(db.getSettings().timezone);
for (let i = 0; i < 200 && !hasLessons(day); i++) day = addDays(day, -1);
const CLOCK = `${day} 10:40`;
process.env.DEMO_CLOCK = CLOCK;
const scanner = require('../src/scanner');
const clockMin = toMin('10:40');

const days = [day];
for (let dd = addDays(day, -1); days.length < 5; dd = addDays(dd, -1)) if (hasLessons(dd)) days.unshift(dd);

d.transaction(() => {
  // A demo scanner, approved, and a staff number for every teacher.
  d.prepare(`INSERT OR IGNORE INTO scan_devices (serial, name, status, last_seen_at, last_ip, approved_at)
    VALUES ('DEMO-K40-0001', 'Bureau / Office (démo)', 'active', ?, '192.168.1.50', ?)`).run(`${day} 10:39:00`, `${days[0]} 07:00:00`);
  let next = 201;
  for (const tch of d.prepare("SELECT id FROM users WHERE role = 'teacher' AND scanner_pin IS NULL ORDER BY id").all()) {
    while (d.prepare('SELECT 1 FROM users WHERE scanner_pin = ?').get(String(next))) next++;
    d.prepare('UPDATE users SET scanner_pin = ? WHERE id = ?').run(String(next++), tch.id);
  }
  db.setSetting('scanner_start_date', days[0]);
  // The demo's own hand-typed lessons on these days make way for the scanner.
  for (const date of days) d.prepare('DELETE FROM class_sessions WHERE date = ? AND slot_id IS NOT NULL').run(date);
})();
const device = d.prepare("SELECT id FROM scan_devices WHERE serial = 'DEMO-K40-0001'").get().id;

const scans = [];
const forgotten = [];
for (const date of days) {
  const today = date === day;
  for (const tch of d.prepare("SELECT id, scanner_pin FROM users WHERE role = 'teacher' AND scanner_pin IS NOT NULL").all()) {
    // One period per time range (a teacher may have several classes at once).
    const periods = [...new Map(scanner.slotsFor(tch.id, date).map((s) => [`${s.start_time}|${s.end_time}`, s])).values()];
    let inside = false;
    let last = -1; // minute of this teacher's last scan
    periods.forEach((p, i) => {
      const st = toMin(p.start_time); const en = toMin(p.end_time);
      if (today && st > clockMin) return; // later today: not started yet
      const add = (m) => { last = m; scans.push({ pin: tch.scanner_pin, scanned_at: `${date} ${pad(m)}:${String(between(0, 59)).padStart(2, '0')}` }); };
      const r = rand();
      if (!inside) {
        if (r < 0.04) return; // never scanned
        const at = r < 0.13 ? st + between(16, 24) : st - between(2, 9);
        // Straight from the previous lesson: the scan back also starts this one.
        const prevP = periods[i - 1];
        if (!(prevP && st - toMin(prevP.end_time) <= 10 && last >= st - 15)) add(at);
      }
      if (today && en > clockMin) { inside = true; return; } // in class right now
      const nextP = periods[i + 1];
      if (nextP && toMin(nextP.start_time) - en <= 10 && rand() < 0.5) { inside = true; return; } // stays for the next lesson
      inside = false;
      const r2 = rand();
      if (r2 < 0.05) { forgotten.push({ user: tch.id, slot: p.id, date }); return; } // forgot the scan back
      add(r2 < 0.1 ? en - between(12, 20) : en + between(0, 5));
    });
  }
}
scans.push({ pin: '999', scanned_at: `${day} 07:12:30` }); // a staff number nobody has yet
const res = scanner.addScans(scans, { deviceId: device, source: 'device' });
for (const date of days) scanner.recomputeDate(date);
// One teacher asks for a correction for a forgotten scan back.
const f = forgotten.find((x) => x.date !== day);
if (f) d.prepare('INSERT INTO scan_corrections (user_id, slot_id, date, reason) VALUES (?, ?, ?, ?)').run(f.user, f.slot, f.date, "J'ai oublié de pointer au retour (démo) / I forgot to scan back (demo)");
console.log(`Demo scans: ${res.added} on ${days.length} school days, frozen at ${CLOCK}.`);
db.close();
console.log(CLOCK);
