'use strict';
// Navigation for the signed-in portal, per role. Every entry mirrors a route the role can
// already open (the routes check permissions themselves): this file only decides what is
// shown, never what is allowed.

// key: translation key; icon: symbol in public/icons.svg; match: path prefixes that mark the item active.
const ITEMS = {
  home: { href: '/', key: 'nav.dashboard', icon: 'home', match: [] },
  teaching: { href: '/teaching', key: 'nav.teaching', icon: 'clock', match: ['/teaching', '/sessions'] },
  attendance: { href: '/attendance', key: 'nav.attendance', icon: 'attendance', match: ['/attendance'] },
  progress: { href: '/progress', key: 'nav.progress', icon: 'progress', match: ['/progress'] },
  plans: { href: '/plans', key: 'nav.plans', icon: 'book', match: ['/plans'] },
  timetable: { href: '/timetable', key: 'nav.timetable', icon: 'calendar', match: ['/timetable'] },
  adminTimetable: { href: '/admin/timetable', key: 'nav.timetable', icon: 'calendar', match: ['/admin/timetable'] },
  reports: { href: '/reports/hours', key: 'nav.reports', icon: 'chart', match: ['/reports'] },
  myRecord: { href: '/me', key: 'nav.myRecord', icon: 'file', match: ['/me', '/students'] },
  announcements: { href: '/announcements', key: 'nav.announcements', icon: 'megaphone', match: ['/announcements'] },
  notifications: { href: '/notifications', key: 'nav.notifications', icon: 'bell', match: ['/notifications'], count: 'unread' },
  students: { href: '/admin/students', key: 'admin.students', icon: 'users', match: ['/admin/students', '/admin/guardians', '/students'] },
  accounts: { href: '/admin/users', key: 'admin.users', icon: 'user', match: ['/admin/users'] },
  requests: { href: '/admin/requests', key: 'nav.requests', icon: 'inbox', match: ['/admin/requests'], count: 'requests' },
  structure: { href: '/admin/structure', key: 'nav.structure', icon: 'structure', match: ['/admin/structure'] },
  settings: { href: '/admin/settings', key: 'admin.settings', icon: 'settings', match: ['/admin/settings'] },
  outbox: { href: '/admin/outbox', key: 'outbox.title', icon: 'send', match: ['/admin/outbox'] },
  audit: { href: '/admin/audit', key: 'nav.audit', icon: 'history', match: ['/admin/audit'] },
};

// Sidebar groups per role (group title key, or null for the ungrouped top entries).
const MENUS = {
  admin: [
    [null, ['home']],
    ['nav.groupTeaching', ['teaching', 'attendance', 'progress', 'plans', 'adminTimetable', 'reports']],
    ['nav.groupPeople', ['students', 'accounts', 'announcements', 'requests']],
    ['nav.groupSchool', ['structure', 'settings', 'outbox', 'audit']],
  ],
  teacher: [[null, ['home', 'teaching', 'attendance', 'progress', 'plans', 'timetable', 'reports', 'announcements']]],
  parent: [[null, ['home', 'timetable', 'announcements', 'notifications']]],
  student: [[null, ['home', 'myRecord', 'timetable', 'announcements']]],
  bursar: [[null, ['home']]],
};

// Bottom tab bar on phones (at most four entries; 'more' opens the full menu).
const TABS = {
  teacher: ['home', 'attendance', 'progress', 'more'],
  parent: ['home', 'timetable', 'announcements', 'notifications'],
  student: ['home', 'myRecord', 'timetable', 'announcements'],
};

function isActive(item, path) {
  if (item.href === '/') return path === '/';
  return item.match.some((p) => path === p || path.startsWith(`${p}/`));
}

function build(role, path, counts = {}) {
  const groups = (MENUS[role] || []).map(([title, keys]) => ({
    title,
    items: keys.map((k) => {
      const it = ITEMS[k];
      return { id: k, href: it.href, key: it.key, icon: it.icon, active: isActive(it, path), count: it.count ? counts[it.count] || 0 : 0 };
    }),
  }));
  const all = groups.flatMap((g) => g.items);
  const tabs = (TABS[role] || []).map((k) => (k === 'more' ? { id: 'more', href: '#menu', key: 'nav.more', icon: 'menu', active: false, count: 0 } : all.find((i) => i.id === k)));
  return { groups, tabs };
}

module.exports = { build, ITEMS, MENUS, TABS };
