'use strict';
// Administrator configuration: school structure, users, students, teaching assignments,
// timetables, access requests and settings. Every route here requires the admin role on the
// server: the guard below runs first, and each section file repeats it as a safety net.
const express = require('express');
const auth = require('../../auth');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));

r.get('/admin', (req, res) => res.render('admin/index', { title: req.t('admin.title') }));

// Same order as before the split, so route matching is unchanged.
r.use(require('./structure'));
r.use(require('./users'));
r.use(require('./students'));
r.use(require('./timetable'));
r.use(require('./requests'));
r.use(require('./settings'));

module.exports = r;
