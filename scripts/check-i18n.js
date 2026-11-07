'use strict';
// Checks that English and French translation files have exactly the same keys,
// and that every fixed key used in code and templates exists.
const fs = require('fs');
const path = require('path');
const { dictionaries } = require('../src/i18n');

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out); else out[key] = v;
  }
  return out;
}

const en = flatten(dictionaries.en);
const fr = flatten(dictionaries.fr);
const problems = [];
for (const k of Object.keys(en)) if (!(k in fr)) problems.push(`missing in fr.json: ${k}`);
for (const k of Object.keys(fr)) if (!(k in en)) problems.push(`missing in en.json: ${k}`);
for (const [k, v] of Object.entries(en)) {
  const pe = (v.match(/\{\w+\}/g) || []).sort().join();
  const pf = ((fr[k] || '').match(/\{\w+\}/g) || []).sort().join();
  if (k in fr && pe !== pf) problems.push(`placeholders differ for ${k}: en(${pe}) fr(${pf})`);
}

// Keys used literally in source: t('a.b'), key: 'a.b', res.flash('x', 'a.b')
const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!['node_modules', 'data', '.git'].includes(f.name)) walk(p); } else if (/\.(js|ejs)$/.test(f.name)) files.push(p);
  }
})(path.join(root, 'src'));
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p); else files.push(p);
  }
})(path.join(root, 'views'));

const patterns = [/\bt\('([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)'\)/g, /\bt\('([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)',/g, /key: '([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)'/g, /flash\('\w+', '([a-zA-Z0-9_.]+)'\)/g, /back\(res, [^,]+, '\w+', '([a-zA-Z0-9_.]+)'\)/g];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const re of patterns) {
    for (const m of src.matchAll(re)) if (!(m[1] in en)) problems.push(`${path.relative(root, file)}: unknown key ${m[1]}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Translations OK: ${Object.keys(en).length} keys in English and French.`);
