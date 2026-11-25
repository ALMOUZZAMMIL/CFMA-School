'use strict';
// Groups yearly plans by section, then cycle, then class, in school order
// (6e before 5e, Form 1 before Form 2, A1 before A2...), so long lists stay readable.

const ORDER = ['6e', '5e', '4e', '3e', 'Form 1', 'Form 2', 'Form 3', 'Form 4', 'Form 5', 'A1', 'A2', 'A3', 'A4', 'Année 1', 'Année 2', 'Année 3', 'Année 4',
  '2nde', 'Seconde', '1ère', '1ere', 'Première', 'Lower Sixth', 'Upper Sixth', 'Tle', 'Terminale', 'PA', 'PD'];
const FIRST_CYCLE = /^(6e|5e|4e|3e|Form [1-5]|A[1-4]|Année [1-4])$/i;

function rank(level) {
  const i = ORDER.findIndex((o) => level === o || level.startsWith(o + ' '));
  return i < 0 ? ORDER.length : i;
}
function compareLevels(a, b) { return rank(a) - rank(b) || a.localeCompare(b, 'fr'); }

// rows: plans or classes with section_id, section_en/fr, level, subject_en/fr. Returns
// [{ section_id, section_en, section_fr, cycles: [{ cycle: 1|2, classes: [{ level, items: [] }] }] }]
function groupByClassLevel(rows) {
  const sections = new Map();
  for (const p of rows) {
    if (!sections.has(p.section_id)) sections.set(p.section_id, { section_id: p.section_id, section_en: p.section_en, section_fr: p.section_fr, levels: new Map() });
    const s = sections.get(p.section_id);
    if (!s.levels.has(p.level)) s.levels.set(p.level, []);
    s.levels.get(p.level).push(p);
  }
  return [...sections.values()].map((s) => {
    const cycles = [1, 2].map((cycle) => ({
      cycle,
      classes: [...s.levels.keys()].filter((l) => (FIRST_CYCLE.test(l) ? 1 : 2) === cycle).sort(compareLevels)
        .map((level) => ({ level, items: s.levels.get(level) })),
    })).filter((c) => c.classes.length);
    return { section_id: s.section_id, section_en: s.section_en, section_fr: s.section_fr, cycles };
  });
}

module.exports = { groupByClassLevel, groupPlans: groupByClassLevel, compareLevels };
