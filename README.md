# CFMA School — bilingual school management system

*Version française plus bas.*

A lightweight web application for a secondary school in Cameroon. It runs in English and French and is used by administrators, teachers, students and parents. This first release covers:

- **Teaching hours.** Timetables by teacher, class, subject, day, term and school year. Teachers can record each lesson as held, missed, cancelled or made up. Totals show scheduled, taught, missed and make-up hours.
- **Yearly plans and lesson progress.** Plans are kept per section, level and subject, with chapters, lessons and planned dates. Plans can be entered by hand or pasted in from Excel. Teachers record progress, and reports compare it with the plan for any date.
- **Student attendance.** Daily attendance by class (present, absent, late, excused), with a history of corrections and a report of repeated absences. A printable paper register is included, and parents can get optional in-app alerts.
- **Announcements.** Bilingual notices that target teachers, students and/or parents, and the whole school or one class. They can be scheduled to appear and to expire. SMS texts can be *prepared* for later sending, but they are never shown as sent.

Marks and report cards, finance, real SMS or WhatsApp sending, and offline entry are planned for later phases (see "What is not done yet").

> **Privacy first.** The system ships with clearly labelled demo data only. Before entering any real student or family information, the school should confirm its own data-protection and child-safeguarding requirements. This software makes no claim of legal compliance or official approval by any Cameroonian authority.

---

## Technology (and why)

| Choice | Why |
|---|---|
| **Node.js 20+ and Express** | Common, free, and easy to host on a cheap VPS, a school PC or a free hosting tier. |
| **Server-rendered pages (EJS)** with a tiny script (`public/app.js`) | Pages are small and work on basic smartphones and slow connections. Everything still works if JavaScript is off. |
| **SQLite** (`better-sqlite3`) | The whole database is one file. There is no database server to run, and a backup is just a copy of that file. |
| **JSON translation files** (`locales/en.json`, `locales/fr.json`) | Every piece of interface text lives in one place. `npm run check-i18n` checks that both languages are complete. |
| **Only 3 runtime dependencies** | Fewer things to update or break. |

## Quick start (demo)

```bash
git clone https://github.com/ALMOUZZAMMIL/CFMA-School.git
cd CFMA-School
npm install
npm run seed          # loads fictional demo data into data/school.db
npm start             # http://localhost:3000
```

Every demo account uses the password `demo-password`:

| Username | Role |
|---|---|
| `demo.admin` | Administrator |
| `demo.prof.maths` | Teacher (General and Technical sections) |
| `demo.prof.lettres`, `demo.prof.tech` | Teachers |
| `demo.teacher.eng` | Teacher (Anglophone section) |
| `demo.parent` | Parent of two children |
| `demo.parent.en` | Parent (English interface) |
| `demo.eleve` | Student |
| `demo.intendant` | Bursar (finance module not built yet) |

To start the demo again from scratch, run `npm run seed -- --reset`.

## Real installation

1. Install Node.js 20 or newer.
2. `npm install --omit=dev`
3. `cp .env.example .env`, then adjust it (see the comments in the file).
4. Create the first administrator: `npm run create-admin -- admin.username "Full Name"`. A temporary password is printed once, and it must be changed at first sign-in.
5. `npm start`, then sign in and follow the setup checklist on the home page.
6. **Serve it over HTTPS** in production, for example with Caddy as a reverse proxy, which provides free certificates automatically. Then set `NODE_ENV=production` and `TRUST_PROXY=1`.
7. **Back up `data/school.db` every day**, for example with a scheduled copy to another disk or to cloud storage. Use `sqlite3 data/school.db ".backup backup.db"` while the server is running.

Low-cost hosting options include a small VPS (about USD 4–6 a month), a computer on the school's own network with no internet needed, or any Node.js host that offers a persistent disk.

## Tests

```bash
npm test             # permission, CSRF, duplicate-protection, history and visibility tests
npm run check-i18n   # English and French files have the same keys and placeholders
```

## Public pages, sign-in and account requests

- **Welcome page (`/`)** for visitors, with the school's logo, name, motto and contact details from *Administration > Settings*. Empty contact fields show as "to be provided" instead of invented details.
- **Sign in (`/login`)** with username *or* email, a show/hide password button and the same error message whether the account exists or not.
- **Request an account (`/register`).** Public registration never creates an account. A parent, teacher or student fills in a short form, which goes to *Administration > Access requests*. The administrator checks the person's identity, then creates the account with a temporary password and, for a parent, links the child they have checked. Administrator and bursar accounts can never be requested. The form has a per-connection limit and a hidden anti-bot field. It can be switched off in Settings.
- **Forgot password (`/forgot-password`)** also creates a request for the administration, which resets the password after checking identity. The answer is the same whether or not the account exists, and no email or SMS is sent.

### Logo and colours

Put the school logo in `public/brand/` as `logo.svg`, `logo.png`, `logo.webp` or `logo.jpg`. It is shown as supplied (fixed height, never stretched or recoloured). Without a file, the school's initials are shown. The three brand colours are set in *Administration > Settings*; the main colour must be dark enough for white text.

## User roles

| Role | Can do |
|---|---|
| **Administrator** | Everything: school years, terms, closures, sections, subjects, classes, accounts, students, parent links, teaching assignments, timetables, yearly plans, announcements, settings, reports and the change history. |
| **Teacher** | See their own timetable and classes. Record their lessons and make-ups, take attendance for classes they teach, record lesson progress, and view reports for their own classes. |
| **Student** | See their own timetable, attendance, class progress and announcements, if the school has made them visible. |
| **Parent / guardian** | See only the children linked to their account: timetable, attendance, progress, announcements and absence notifications. |
| **Bursar** | Signs in only. The finance module is planned, and bursars cannot see academic records. |

Permissions are checked **on the server** for every request:

- A parent who changes a student id in the URL gets "not found".
- A teacher cannot open or edit another teacher's lessons or classes.
- Every form is protected against CSRF.

The automated tests in `test/app.test.js` cover these cases.

## Database structure (summary)

| Table | Purpose |
|---|---|
| `academic_years`, `terms`, `closures` | School-defined calendar. Closures are excluded from scheduled hours. |
| `sections`, `subjects`, `classes` | General, Technical and Anglophone sections (or any others). A class belongs to a year, a section and a level. |
| `users` | Accounts with a role and a language preference. Passwords are hashed with scrypt. |
| `students`, `enrollments`, `guardians` | Minimal student data (name, student number), which class each student is in each year, and parent links. |
| `teaching_assignments`, `timetable_slots` | Who teaches which subject to which class, and the weekly times for each term. |
| `class_sessions` | What actually happened to each lesson (held, missed, cancelled or make-up), with the reason, make-up status and who recorded it. |
| `plans`, `plan_chapters`, `plan_lessons` | Yearly plans per year, section, level and subject. |
| `progress_entries` | Append-only progress records. The latest entry for a lesson is its current status. |
| `attendance_records` | One record per student, class and day. Corrections keep `updated_by` and `updated_at`. |
| `announcements` | Bilingual notices with audience, class, publish time and expiry time. |
| `notifications` | In-app notices, such as absence alerts to parents. |
| `message_outbox` | SMS texts prepared for a future provider. Status stays `not_sent` until a real integration confirms sending. |
| `audit_log` | History of every creation and correction, with the before and after values, the person and the time. |
| `access_requests` | Account and password requests from the public pages, with their status and who handled them. |
| `sessions`, `settings` | Login sessions and school settings. |

## What the school needs to configure

All of this is done in **Administration**:

1. School name, default language, time zone (`Africa/Douala`) and currency (`XAF`).
2. The school year, its terms, and its holidays and closures.
3. Sections, subjects (in French and English) and classes, using the school's own level names.
4. Accounts for staff and parents. Give temporary passwords privately.
5. Students, with only the information that is needed, placed in classes and linked to parents.
6. Teaching assignments and weekly timetables.
7. Yearly plans for each section, level and subject, entered by hand or pasted from Excel. **No national curriculum is built in.**
8. Whether parents get absence alerts, and what parents and students can see.

## What is not done yet

- **Marks and report cards**: grading scales, averages using the school's own rules, previews and printing. These are planned next. The database and roles are ready for them.
- **Finance module** for the bursar: fee items, payments, balances and receipts. It will be kept separate from academic records.
- **Real SMS or WhatsApp sending.** Messages are prepared and stored, but nothing is sent or marked as sent.
- **Offline entry with sync.** For now the app warns when the connection is lost, and printable registers and CSV exports cover paper fallback. Duplicate submissions are already blocked on the server, which makes adding offline sync later safer.
- Teachers cannot yet post announcements (only administrators can). There is no bulk student import from a spreadsheet yet.

---

## Version française (résumé)

Application web légère de gestion scolaire pour un lycée au Cameroun, entièrement en français et en anglais. Cette première version couvre :

- le suivi des **heures de cours** (assurées, non assurées, annulées et rattrapées) ;
- les **programmes annuels** par section, niveau et matière, et la **progression** comparée au programme ;
- l'**appel** quotidien, avec l'historique des corrections, un registre papier imprimable et les absences répétées ;
- les **annonces** bilingues, programmables et ciblées.

**Démarrage :** `npm install`, puis `npm run seed`, puis `npm start`. Ouvrez ensuite http://localhost:3000. Tous les comptes de démonstration utilisent le mot de passe `demo-password`.

**Installation réelle :** `npm run create-admin -- identifiant "Nom complet"`. Servez l'application en HTTPS et sauvegardez chaque jour le fichier `data/school.db`.

**Confidentialité :** seules des données fictives sont fournies. Avant d'enregistrer de vraies informations sur les élèves, l'établissement doit vérifier ses propres obligations en matière de protection des données et de protection de l'enfance. Ce logiciel ne prétend à aucune conformité légale ni à aucune approbation officielle.

**Prochaines phases :** notes et bulletins, module financier, envoi réel de SMS ou WhatsApp, et saisie hors ligne.
