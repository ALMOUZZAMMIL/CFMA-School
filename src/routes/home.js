'use strict';
const express = require('express');
const db = require('../db');
const access = require('../access');
const reports = require('../reports');
const { weekday } = require('../util');

const r = express.Router();

function visibleAnnouncements(user, limit = 5) {
  const d = db.get();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let classIds = [];
  if (user.role === 'parent' || user.role === 'student') {
    const ids = access.visibleStudentIds(user);
    if (ids.length) {
      classIds = d.prepare(`SELECT DISTINCT class_id FROM enrollments WHERE student_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((x) => x.class_id);
    }
  } else if (user.role === 'teacher') {
    classIds = d.prepare('SELECT DISTINCT class_id FROM teaching_assignments WHERE teacher_id = ?').all(user.id).map((x) => x.class_id);
  }
  const roleCond = user.role === 'admin' ? '1=1' : "(',' || a.audience || ',') LIKE ?";
  const classCond = user.role === 'admin' ? '1=1' : `(a.class_id IS NULL ${classIds.length ? `OR a.class_id IN (${classIds.join(',')})` : ''})`;
  const params = user.role === 'admin' ? [now, now] : [now, now, `%,${user.role},%`];
  return d.prepare(`SELECT a.*, c.name AS class_name FROM announcements a LEFT JOIN classes c ON c.id = a.class_id
    WHERE a.status = 'published' AND a.publish_at <= ? AND (a.expires_at IS NULL OR a.expires_at > ?)
    AND ${roleCond} AND ${classCond} ORDER BY a.publish_at DESC LIMIT ${Number(limit)}`).all(...params);
}

// Attendance per school week, oldest first, for the dashboard chart (read only).
// Rate = (present + late) / all marks: a late pupil was in class.
function weeklyAttendance(year, today, weeks = 8) {
  const d = new Date(`${today}T00:00:00Z`);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const iso = (x) => x.toISOString().slice(0, 10);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const from = new Date(monday);
    from.setUTCDate(monday.getUTCDate() - 7 * i);
    const to = new Date(from);
    to.setUTCDate(from.getUTCDate() + 6);
    if (iso(to) < year.start_date) continue;
    out.push({ from: iso(from) < year.start_date ? year.start_date : iso(from), to: iso(to) > today ? today : iso(to), weekStart: iso(from) });
  }
  if (!out.length) return [];
  const rows = db.get().prepare(`SELECT date, status, COUNT(*) n FROM attendance_records WHERE date BETWEEN ? AND ? GROUP BY date, status`).all(out[0].from, out[out.length - 1].to);
  return out.map((w) => {
    const c = { present: 0, late: 0, absent: 0, excused: 0 };
    rows.filter((r) => r.date >= w.from && r.date <= w.to).forEach((r) => { c[r.status] = (c[r.status] || 0) + r.n; });
    const total = c.present + c.late + c.absent + c.excused;
    return { ...w, ...c, total, rate: total ? Math.round(((c.present + c.late) / total) * 1000) / 10 : null };
  });
}

// Monday..Saturday of the current week, for the week strip above the agenda.
function weekDays(today) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return Array.from({ length: 6 }, (_, i) => {
    const x = new Date(d); x.setUTCDate(d.getUTCDate() + i);
    const date = x.toISOString().slice(0, 10);
    return { date, dow: i + 1, today: date === today };
  });
}

// Today's lessons across the school (admin agenda), from the timetable (read only).
function schoolAgenda(today, limit = 6) {
  return db.get().prepare(`SELECT ts.start_time, ts.end_time, c.name AS class_name, s.name_en AS subject_en, s.name_fr AS subject_fr,
      u.full_name AS teacher_name, cs.status AS session_status
    FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id JOIN teaching_assignments ta ON ta.id = ts.assignment_id
    JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
    LEFT JOIN class_sessions cs ON cs.slot_id = ts.id AND cs.date = @today
    WHERE ts.day_of_week = @dow AND @today BETWEEN t.start_date AND t.end_date
    AND NOT EXISTS (SELECT 1 FROM closures cl WHERE @today BETWEEN cl.start_date AND cl.end_date)
    ORDER BY ts.start_time, c.name LIMIT ${Number(limit)}`).all({ today, dow: weekday(today) });
}

// One pupil's register marks for the last school days (Mon-Fri), oldest first.
function recentDays(studentId, today, days = 10) {
  const out = [];
  const d = new Date(`${today}T00:00:00Z`);
  while (out.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  const rows = db.get().prepare(`SELECT date, status FROM attendance_records WHERE student_id = ? AND date BETWEEN ? AND ? ORDER BY date`).all(studentId, out[0], out[out.length - 1]);
  // Several lessons a day: show the worst mark of the day (absent > late > excused > present).
  const rank = { absent: 4, late: 3, excused: 2, present: 1 };
  return out.map((date) => {
    const marks = rows.filter((r) => r.date === date).map((r) => r.status);
    const status = marks.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || null;
    return { date, status };
  });
}

function sumHours(rows) {
  return rows.reduce((acc, x) => ({ scheduled: acc.scheduled + x.scheduled, delivered: acc.delivered + x.delivered, missed: acc.missed + x.missed + x.cancelled, notRecorded: acc.notRecorded + x.notRecorded }), { scheduled: 0, delivered: 0, missed: 0, notRecorded: 0 });
}

const round1 = (n) => Math.round(n * 10) / 10;

r.get('/', (req, res) => {
  const u = req.user;
  const year = res.locals.year;
  const today = res.locals.today;
  const data = { title: req.t('nav.dashboard'), announcements: visibleAnnouncements(u, 5), week: weekDays(today) };
  if (!year && u.role === 'admin') return res.render('dashboard', { ...data, setupNeeded: true });
  if (u.role === 'teacher') Object.assign(data, { slots: [], hours: null, myProgress: [], pendingMakeups: 0 });
  if (u.role === 'teacher' && year) {
    data.slots = db.get().prepare(`SELECT ts.*, c.name AS class_name, c.id AS class_id, s.name_en AS subject_en, s.name_fr AS subject_fr,
        cs.id AS session_id, cs.status AS session_status,
        (SELECT COUNT(*) FROM attendance_records ar WHERE ar.class_id = c.id AND ar.date = @today) AS attendance_count
      FROM timetable_slots ts JOIN terms t ON t.id = ts.term_id JOIN teaching_assignments ta ON ta.id = ts.assignment_id
      JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
      LEFT JOIN class_sessions cs ON cs.slot_id = ts.id AND cs.date = @today
      WHERE ta.teacher_id = @uid AND ts.day_of_week = @dow AND @today BETWEEN t.start_date AND t.end_date
      AND NOT EXISTS (SELECT 1 FROM closures cl WHERE @today BETWEEN cl.start_date AND cl.end_date)
      ORDER BY ts.start_time`).all({ uid: u.id, today, dow: weekday(today) });
    data.pendingMakeups = db.get().prepare(`SELECT COUNT(*) n FROM class_sessions cs JOIN teaching_assignments ta ON ta.id = cs.assignment_id
      WHERE ta.teacher_id = ? AND cs.status IN ('missed','cancelled') AND cs.makeup_status = 'planned'`).get(u.id).n;
    const summary = reports.hoursSummary({ yearId: year.id, teacherId: u.id, asOf: today });
    data.hours = sumHours(summary.rows);
    ['scheduled', 'delivered', 'missed'].forEach((k) => { data.hours[k] = round1(data.hours[k]); });
    data.myProgress = access.teacherAssignments(u.id, year.id)
      .map((a) => { const p = reports.progressFor({ ...a, year_id: year.id }, today); return { a, p, status: reports.curriculumStatus(p, db.getSettings()) }; })
      .filter((x) => x.p.plan);
  }
  if (u.role === 'admin' && year) {
    const d = db.get();
    data.stats = {
      teachers: d.prepare("SELECT COUNT(*) n FROM users WHERE role = 'teacher' AND active = 1").get().n,
      students: d.prepare('SELECT COUNT(DISTINCT e.student_id) n FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.year_id = ?').get(year.id).n,
      classes: d.prepare('SELECT COUNT(*) n FROM classes WHERE year_id = ?').get(year.id).n,
      sessionsToday: d.prepare('SELECT COUNT(*) n FROM class_sessions WHERE date = ?').get(today).n,
      missedToday: d.prepare("SELECT COUNT(*) n FROM class_sessions WHERE date = ? AND status IN ('missed','cancelled')").get(today).n,
      attendanceClassesToday: d.prepare('SELECT COUNT(DISTINCT class_id) n FROM attendance_records WHERE date = ?').get(today).n,
      absentToday: d.prepare("SELECT COUNT(*) n FROM attendance_records WHERE date = ? AND status = 'absent'").get(today).n,
      pendingMakeups: d.prepare("SELECT COUNT(*) n FROM class_sessions WHERE status IN ('missed','cancelled') AND makeup_status = 'planned'").get().n,
    };
    data.pendingRequests = d.prepare("SELECT COUNT(*) n FROM access_requests WHERE status = 'pending'").get().n;
    const s = db.getSettings();
    data.repeated = reports.repeatedAbsences({ yearId: year.id, threshold: Number(s.repeat_absence_threshold), days: Number(s.repeat_absence_window_days), asOf: today }).slice(0, 5);
    data.trend = weeklyAttendance(year, today);
    data.agenda = schoolAgenda(today);
    data.hours = sumHours(reports.hoursSummary({ yearId: year.id, asOf: today }).rows);
    ['scheduled', 'delivered', 'missed'].forEach((k) => { data.hours[k] = round1(data.hours[k]); });
    // The five teaching assignments furthest behind their yearly plan.
    data.behind = d.prepare(`SELECT ta.*, c.name AS class_name, c.level, c.section_id, c.year_id, s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
      FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id JOIN users u ON u.id = ta.teacher_id
      WHERE c.year_id = ?`).all(year.id)
      .map((a) => { const p = reports.progressFor(a, today); return { a, p, status: reports.curriculumStatus(p, s) }; })
      .filter((x) => x.p.plan && x.p.total);
    data.behindCount = data.behind.filter((x) => x.status === 'behind' || x.status === 'far_behind').length;
    data.behind = data.behind.sort((x, y) => reports.STATUS_ORDER[x.status] - reports.STATUS_ORDER[y.status] || y.p.daysBehind - x.p.daysBehind || x.p.gap - y.p.gap).slice(0, 5);
  }
  if ((u.role === 'parent' || u.role === 'student') && year) {
    const ids = access.visibleStudentIds(u);
    data.children = ids.map((id) => {
      const st = db.get().prepare('SELECT * FROM students WHERE id = ?').get(id);
      const cls = access.studentClass(id, year.id);
      const att = db.get().prepare(`SELECT SUM(status='absent') absent, SUM(status='late') late, SUM(status='excused') excused, COUNT(*) total
        FROM attendance_records WHERE student_id = ? AND date BETWEEN ? AND ?`).get(id, year.start_date, year.end_date);
      return { ...st, class_name: cls && cls.name, att, days: recentDays(id, today) };
    });
  }
  res.render('dashboard', data);
});

r.get('/notifications', (req, res) => {
  const rows = db.get().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  rows.forEach((n) => { n.data = JSON.parse(n.data); });
  res.render('notifications', { title: req.t('nav.notifications'), rows });
});

r.post('/notifications/read', (req, res) => {
  db.get().prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  res.redirect('/notifications');
});

module.exports = r;
module.exports.visibleAnnouncements = visibleAnnouncements;
