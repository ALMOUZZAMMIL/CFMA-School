'use strict';
// Translation system. All interface text lives in locales/en.json and locales/fr.json.
// Use t("section.key", { name: "value" }) in code and templates; never hard-code UI text.
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'fr'];
const dictionaries = {};
for (const lang of LANGS) {
  dictionaries[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'));
}

function lookup(dict, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
}

function translator(lang) {
  const l = LANGS.includes(lang) ? lang : 'fr';
  return function t(key, params) {
    let s = lookup(dictionaries[l], key);
    if (typeof s !== 'string') s = lookup(dictionaries.en, key);
    if (typeof s !== 'string') return key; // visible fallback so missing keys are easy to spot
    if (params) s = s.replace(/\{(\w+)\}/g, (m, p) => (params[p] !== undefined && params[p] !== null ? String(params[p]) : m));
    return s;
  };
}

// Locale-aware formatting in the school's time zone.
function formatters(lang, timezone) {
  const locale = lang === 'en' ? 'en-GB' : 'fr-FR';
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const longDateFmt = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dateTimeFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone });
  const numFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return {
    // Plain dates are stored as YYYY-MM-DD and shown without time-zone shifting.
    date: (d) => (d ? dateFmt.format(new Date(`${d}T00:00:00Z`)) : ''),
    longDate: (d) => (d ? longDateFmt.format(new Date(`${d}T00:00:00Z`)) : ''),
    // Timestamps are stored in UTC ("YYYY-MM-DD HH:MM:SS") and shown in the school's time zone.
    dateTime: (ts) => (ts ? dateTimeFmt.format(new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z'))) : ''),
    number: (n) => numFmt.format(n || 0),
  };
}

module.exports = { LANGS, translator, formatters, dictionaries };
