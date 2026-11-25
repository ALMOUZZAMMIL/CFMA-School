'use strict';
// Server-side data access rules. Every route that loads a class, student or teaching
// assignment goes through these checks, so changing an id in a URL never exposes data.
const db = require('./db');

const STAFF = ['admin', 'teacher'];

function assignment(id) {
  return db.get().prepare(`SELECT ta.*, c.name AS class_name, c.level, c.section_id, c.year_id,
      s.name_en AS subject_en, s.name_fr AS subject_fr, u.full_name AS teacher_name
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
    JOIN users u ON u.id = ta.teacher_id WHERE ta.id = ?`).get(id);
}

// Can this user record sessions / progress for this teaching assignment?
function canManageAssignment(user, a) {
  if (!a || !user) return false;
  return user.role === 'admin' || (user.role === 'teacher' && a.teacher_id === user.id);
}

// Can this user take attendance for this class? Admins, or teachers who teach the class.
function canTakeAttendance(user, classId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher') return false;
  return !!db.get().prepare('SELECT 1 FROM teaching_assignments WHERE teacher_id = ? AND class_id = ? LIMIT 1').get(user.id, classId);
}

// Student ids this user is allowed to view.
function visibleStudentIds(user) {
  if (!user) return [];
  if (user.role === 'parent') {
    return db.get().prepare('SELECT student_id FROM guardians WHERE parent_user_id = ?').all(user.id).map((r) => r.student_id);
  }
  if (user.role === 'student') {
    const s = db.get().prepare('SELECT id FROM students WHERE user_id = ?').get(user.id);
    return s ? [s.id] : [];
  }
  return null; // staff: decided per class below
}

function canViewStudent(user, studentId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'parent' || user.role === 'student') return visibleStudentIds(user).includes(studentId);
  if (user.role === 'teacher') {
    return !!db.get().prepare(`SELECT 1 FROM enrollments e JOIN teaching_assignments ta ON ta.class_id = e.class_id
      WHERE e.student_id = ? AND ta.teacher_id = ? LIMIT 1`).get(studentId, user.id);
  }
  return false; // bursar has no access to academic records
}

function studentClass(studentId, yearId) {
  return db.get().prepare(`SELECT c.* FROM enrollments e JOIN classes c ON c.id = e.class_id
    WHERE e.student_id = ? AND c.year_id = ? LIMIT 1`).get(studentId, yearId);
}

function teacherAssignments(teacherId, yearId) {
  return db.get().prepare(`SELECT ta.*, c.name AS class_name, c.level, c.section_id, s.name_en AS subject_en, s.name_fr AS subject_fr
    FROM teaching_assignments ta JOIN classes c ON c.id = ta.class_id JOIN subjects s ON s.id = ta.subject_id
    WHERE ta.teacher_id = ? AND c.year_id = ? ORDER BY c.name, s.name_en`).all(teacherId, yearId);
}

module.exports = { STAFF, assignment, canManageAssignment, canTakeAttendance, visibleStudentIds, canViewStudent, studentClass, teacherAssignments };
