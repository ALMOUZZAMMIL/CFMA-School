'use strict';
// Small helpers: dates in the school's time zone, validation, and duration maths.

function todayIn(timezone) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function minutesBetween(start, end) {
  const [h1, m1] = start.split(':').map(Number);
  const [h2, m2] = end.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

// ISO weekday 1 (Monday) .. 7 (Sunday) for a YYYY-MM-DD date
function weekday(date) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eachDate(start, end, fn) {
  for (let d = start; d <= end; d = addDays(d, 1)) fn(d);
}

function int(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && String(n) === String(v).trim() ? n : null;
}

function str(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

// Collects validation errors as translation keys, so messages appear in the user's language.
class Validator {
  constructor() { this.errors = []; }
  required(value, field) { if (value === '' || value === null || value === undefined) this.errors.push({ field, key: 'validation.required' }); return this; }
  date(value, field) { if (value && !isDate(value)) this.errors.push({ field, key: 'validation.date' }); return this; }
  time(value, field) { if (value && !isTime(value)) this.errors.push({ field, key: 'validation.time' }); return this; }
  oneOf(value, list, field) { if (value && !list.includes(value)) this.errors.push({ field, key: 'validation.choice' }); return this; }
  check(cond, field, key) { if (!cond) this.errors.push({ field, key }); return this; }
  get ok() { return this.errors.length === 0; }
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Guard against spreadsheet formula injection when files are opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(headers, rows) {
  // BOM so Excel opens accented French text correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Minimal CSV parser for plan imports (handles quotes and commas or semicolons).
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') inQuotes = false; else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

module.exports = { todayIn, isDate, isTime, minutesBetween, weekday, addDays, eachDate, int, str, Validator, toCsv, parseCsv };
