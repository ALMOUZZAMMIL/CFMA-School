'use strict';
// School identity: logo file, brand colours and the generated brand stylesheet.
// The logo is used exactly as supplied (never recoloured or stretched): put the file in
// public/brand/ as logo.svg, logo.png, logo.webp or logo.jpg.
const fs = require('fs');
const path = require('path');

const BRAND_DIR = path.join(__dirname, '..', 'public', 'brand');
const LOGO_NAMES = ['logo.svg', 'logo.png', 'logo.webp', 'logo.jpg', 'logo.jpeg'];

let cache = { at: 0, url: null };
function logoUrl() {
  // Re-check at most once a minute so a newly added logo appears without a restart.
  if (Date.now() - cache.at < 60000) return cache.url;
  const found = LOGO_NAMES.find((n) => fs.existsSync(path.join(BRAND_DIR, n)));
  let url = null;
  if (found) url = `/static/brand/${found}?v=${Math.floor(fs.statSync(path.join(BRAND_DIR, found)).mtimeMs)}`;
  cache = { at: Date.now(), url };
  return url;
}

function initials(name) {
  return String(name || '').split(/[\s/–-]+/).filter((w) => /^[A-Za-zÀ-ÿ]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '•';
}

const HEX = /^#[0-9a-fA-F]{6}$/;
function rgb(hex) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); }
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function mix(hex, withHex, amount) {
  const a = rgb(hex);
  const b = rgb(withHex);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`;
}

// Generated CSS variables from the brand colours (served at /brand.css; the strict CSP
// does not allow inline styles).
function css(settings) {
  const primary = HEX.test(settings.brand_primary) ? settings.brand_primary : '#2b3f98';
  const accent = HEX.test(settings.brand_accent) ? settings.brand_accent : '#1d7f43';
  const secondary = HEX.test(settings.brand_secondary) ? settings.brand_secondary : '#8e3c96';
  // Accent is used for decoration and on dark backgrounds; a darker shade is used for text.
  let accentText = accent;
  for (let i = 0; i < 10 && contrast(accentText, '#ffffff') < 4.5; i++) accentText = mix(accentText, '#000000', 0.15);
  return `:root{--primary:${primary};--primary-dark:${mix(primary, '#000000', 0.25)};--primary-soft:${mix(primary, '#ffffff', 0.88)};--primary-tint:${mix(primary, '#ffffff', 0.94)};--accent:${accent};--accent-text:${accentText};--accent-soft:${mix(accent, '#ffffff', 0.85)};--secondary:${secondary};--secondary-soft:${mix(secondary, '#ffffff', 0.88)};}\n`;
}

module.exports = { logoUrl, initials, contrast, css, HEX };
