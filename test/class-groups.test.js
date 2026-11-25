'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { groupByClassLevel } = require('../src/class-groups');

test('classes are grouped by section, cycle and school order', () => {
  const rows = ['Tle D', '2nde C', '3e', '6e', '1ère A'].map((level) => ({ section_id: 1, section_en: 'General', level }));
  rows.push({ section_id: 2, level: 'Année 2' }, { section_id: 2, level: '2nde F' }, { section_id: 2, level: 'Année 1' });
  const g = groupByClassLevel(rows);
  assert.deepStrictEqual(g.map((s) => s.cycles.map((c) => c.classes.map((k) => k.level))), [
    [['6e', '3e'], ['2nde C', '1ère A', 'Tle D']],
    [['Année 1', 'Année 2'], ['2nde F']],
  ]);
});
