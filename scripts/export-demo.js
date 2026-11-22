#!/usr/bin/env node
// Builds a static, read-only copy of the portal with the fictional demo data,
// for previews on static hosts (Vercel, GitHub Pages). Nothing real is used:
// a throw-away database is seeded with demo records, the app is started
// locally, every page each demo account can open is saved as HTML, and the
// links are rewritten to point at those files. Forms do not save anything.
//
//   npm run export-demo            -> writes ./dist
//
// The real school installation never uses this; it runs `npm start`.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT = 200; // pages per role and language
const LANGS = ['fr', 'en'];
const ROLES = [
  { dir: 'admin', user: 'demo.admin' },
  { dir: 'enseignant', user: 'demo.prof.maths' },
  { dir: 'parent', user: 'demo.parent' },
  { dir: 'eleve', user: 'demo.eleve' },
  { dir: 'intendant', user: 'demo.intendant' },
];
const LABELS = {
  fr: { visiteur: 'Visiteur', admin: 'Administration', enseignant: 'Enseignant', parent: 'Parent', eleve: 'Élève', intendant: 'Intendant',
    banner: 'Aperçu de démonstration (données fictives). Les liens fonctionnent, les formulaires n’enregistrent rien.', view: 'Voir en tant que :',
    missing: 'Cette page n’est pas incluse dans l’aperçu.', back: 'Retour à l’accueil', saved: 'Aperçu seulement : rien n’a été enregistré.' },
  en: { visiteur: 'Visitor', admin: 'Administration', enseignant: 'Teacher', parent: 'Parent', eleve: 'Student', intendant: 'Bursar',
    banner: 'Demo preview (fictional data). Links work; forms do not save anything.', view: 'View as:',
    missing: 'This page is not included in the preview.', back: 'Back to home', saved: 'Preview only: nothing was saved.' },
};
const SKIP = /^\/(logout|lang|session\/status|healthz|brand\.css|static\/)|\.(csv|pdf|zip)(\?|$)|[?&](format|download)=/;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csma-demo-'));
const env = { ...process.env, NODE_ENV: 'development', DATABASE_FILE: path.join(tmp, 'demo.db'), PORT: String(PORT) };

function fileFor(key) {
  if (key === '/') return 'index.html';
  return key.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/_$/, '') + '.html';
}

class Browser {
  constructor() { this.jar = {}; }
  cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  keep(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      this.jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  async get(p) {
    const res = await fetch(BASE + p, { headers: { cookie: this.cookie() }, redirect: 'manual' });
    this.keep(res);
    return res;
  }
  async post(p, form) {
    const res = await fetch(BASE + p, { method: 'POST', body: new URLSearchParams(form), headers: { cookie: this.cookie(), 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    this.keep(res);
    return res;
  }
  async csrf(p) {
    const html = await (await this.get(p)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
}

async function crawl(b, start) {
  const pages = new Map(); const queue = [start];
  while (queue.length && pages.size < LIMIT) {
    const key = queue.shift();
    if (pages.has(key)) continue;
    const res = await b.get(key);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) { await res.arrayBuffer().catch(() => {}); continue; }
    const html = await res.text();
    pages.set(key, html);
    for (const m of html.matchAll(/<a\b[^>]*?\shref="(\/[^"#]*)/g)) {
      const k = m[1].replace(/&amp;/g, '&');
      if (!SKIP.test(k) && !pages.has(k) && !queue.includes(k)) queue.push(k);
    }
  }
  return pages;
}

function rewrite(html, pages, lang, dir) {
  const L = LABELS[lang];
  const roleLinks = ['visiteur', ...ROLES.map((r) => r.dir)].map((d) => `<a href="../${d}/index.html"${d === dir ? ' class="on" aria-current="true"' : ''}>${L[d]}</a>`).join(' ');
  const banner = `<div class="pvw-banner" role="note"><strong>${L.banner}</strong> <span>${L.view} ${roleLinks}</span></div>`;
  return html
    .replace(/(href|src)="\/static\/([^"?#]*)(\?[^"#]*)?/g, '$1="../../assets/$2')
    .replace(/href="\/brand\.css[^"]*"/g, 'href="../../assets/brand.css"')
    .replace(/id="session-warning"/, 'id="session-warning-off"')
    .replace(/<a\b([^>]*?)\shref="(\/[^"#]*)([^"]*)"/g, (all, attrs, p, frag) => {
      const k = p.replace(/&amp;/g, '&');
      const target = pages.has(k) ? fileFor(k) : 'missing.html';
      return `<a${attrs} href="${target}${frag}"`;
    })
    .replace('</head>', '<link rel="stylesheet" href="../../assets/preview.css"><script src="../../assets/preview.js" defer></script></head>')
    .replace(/<body([^>]*)>/, `<body$1 data-pvw-lang="${lang}" data-pvw-role="${dir}">${banner}`);
}

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

function save(pages, lang, dir) {
  const L = LABELS[lang];
  for (const [key, html] of pages) write(path.join(OUT, lang, dir, fileFor(key)), rewrite(html, pages, lang, dir));
  write(path.join(OUT, lang, dir, 'missing.html'), `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${L.missing}</title><link rel="stylesheet" href="../../assets/style.css"><link rel="stylesheet" href="../../assets/preview.css"></head><body class="pvw-missing"><main class="container"><div class="empty card"><p>${L.missing}</p><a class="btn btn-primary" href="index.html">${L.back}</a></div></main></body></html>`);
  console.log(`  ${lang}/${dir}: ${pages.size} pages`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], { env, stdio: 'ignore' });
  // The school's own calendar, timetable and programmes (teachers by code only, never names).
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'import-school-data.js')], { env, stdio: 'ignore' });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const lang of LANGS) {
      const visitor = new Browser();
      visitor.jar.lang = lang;
      save(await crawl(visitor, '/'), lang, 'visiteur');
    }
    for (const role of ROLES) {
      const b = new Browser();
      const token = await b.csrf('/login');
      const res = await b.post('/login', { _csrf: token, username: role.user, password: 'demo-password' });
      if (res.status !== 302) throw new Error(`Login failed for ${role.user} (${res.status})`);
      for (const lang of LANGS) {
        await b.post('/lang', { _csrf: await b.csrf('/'), lang, back: '/' });
        save(await crawl(b, '/'), lang, role.dir);
      }
    }
    const brandCss = await (await fetch(BASE + '/brand.css')).text();
    fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'assets'), { recursive: true });
    write(path.join(OUT, 'assets', 'brand.css'), brandCss);
    const css = path.join(OUT, 'assets', 'style.css');
    fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace(/url\("\/static\//g, 'url("'));
    fs.copyFileSync(path.join(__dirname, 'export-demo', 'preview.css'), path.join(OUT, 'assets', 'preview.css'));
    fs.copyFileSync(path.join(__dirname, 'export-demo', 'preview.js'), path.join(OUT, 'assets', 'preview.js'));
    write(path.join(OUT, 'index.html'), '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Démo · Demo</title><meta http-equiv="refresh" content="0; url=fr/visiteur/index.html"></head><body><p><a href="fr/visiteur/index.html">Ouvrir la démonstration</a> · <a href="en/visiteur/index.html">Open the demo</a></p></body></html>');
    console.log(`Static demo written to ${path.relative(ROOT, OUT)}/`);
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
