# Fingerprint scanner for teacher attendance

Teachers scan a finger at the office **before going to class** and **again when they come back**.
The portal matches the two scans to the teacher's timetable and records the lesson as taught,
so the hours report fills itself in. Teachers can see their scans but never change them.

## What to buy

One **ZKTeco K40** (about 100,000 FCFA in Yaoundé, network port and built-in battery) is enough
for a small school. The F18 or UA400 also work. Before paying, ask the seller to open
**Menu → Comm. → Cloud Server Setting** (sometimes called **ADMS**) on the device. If that menu
is missing, the device can still be used with a USB stick (see below).

## Privacy

Fingerprints stay inside the scanner. The portal only receives "staff number 102 scanned at
10:20". If the scanner sends user lists or fingerprint templates, the portal throws them away
without storing them. Scans are kept as evidence: the database refuses any change or deletion.
When a teacher leaves the school, delete their fingerprint on the scanner itself.

## Setting up (once)

1. **Run the portal on the school computer** (or a server) on the same network as the scanner.
   The free online demo cannot receive scans.
2. **Connect the scanner** with a network cable to the school router or switch.
3. **On the scanner**: Menu → Comm. → Cloud Server Setting. Server address = the address of the
   portal computer (for example `192.168.1.10`), port = the portal's port (`3000` unless changed).
   Turn off "domain name" and "proxy". Restart the scanner.
4. **In the portal**: Administration → *Fingerprint scanner* → *Scanner set-up*. Within a minute
   the scanner appears as "Waiting for approval". Check the serial number against the sticker and
   click **Approve**. Optionally type its address in "Only from address".
5. **Enrol each teacher's finger on the scanner** (Menu → User Mgt. → New User). Note the
   "User ID" the scanner gives them, and type it as the teacher's **staff number** in the portal.
6. Give the scanner's admin menu a password, so teachers cannot enrol other fingers or change the clock.

Check the scanner's date and time. If its clock runs ahead, the set-up page shows a warning.

## Without a network: USB file

On the scanner: Menu → USB Manager → Download → Attendance data. Plug the stick into the
portal computer, open *Scanner set-up → Upload a USB file*, choose `1_attlog.dat`, and upload.
Scans already received are ignored, so uploading the same file twice is safe.

## The matching rules (defaults)

All of these can be changed in *Scanner set-up → Matching rules*.

| Situation | What the portal does |
| --- | --- |
| First scan up to 15 min before or after the start, second scan after the end | Lesson **finished**, counted in full |
| First scan 15 to 30 min late | Finished, flagged **late** |
| First scan more than 30 min late | **Very late**: waits for an admin decision before it counts |
| Second scan more than 10 min before the end | Finished, flagged **left early** |
| Two lessons with 10 min or less between them | One scan out and one scan back cover both |
| No second scan 30 min after the end | **No scan back**: goes to the review list |
| Two scans within 2 min | Counted as one |
| A scan outside every lesson, or an unknown staff number | Listed under **Scans with no lesson** for the admin |
| No scan at all, once the day is over | Recorded as **missed** (only from the day the first scanner was approved, and only for teachers with a staff number) |

The portal brings the day up to date every 5 minutes and whenever a scan arrives, so a scan
that arrives late (scanner offline, USB upload) is matched using the time it was taken.

## Who can change what

- **Teachers** see *My scans*: their lessons of the day, their scans of the last 14 days, and
  their correction requests. They cannot edit a scanned lesson, and while a scanner is in use
  they cannot type timetabled lessons in by hand ("Teachers cannot type in timetabled lessons"
  rule, on by default). If something is wrong they send a **correction request** with a reason.
- **Administrators** see *Scanner: today's lessons*: every lesson with its scans, the review list
  and the correction requests. Every decision ("Count as taught" / "Mark missed") needs a reason
  and is kept in the history.
- **Nobody** can change or delete a scan.

The hours report has a **Scanned** column: hours held that are backed by a scan or an approved
correction, next to the total held hours.

## Trying it without a scanner

On a test or demo site, *Scanner set-up → Try it without a scanner* adds a scan as if a teacher
had used the device. This section does not appear on a real school site (`NODE_ENV=production`
without demo data).

## Technical notes

- Device endpoints (ZKTeco "push"/ADMS protocol): `GET/POST /iclock/cdata`, `GET /iclock/getrequest`,
  `POST /iclock/devicecmd`. They use no session or cookie and answer only to a serial number the
  admin has approved (an unknown device is registered as pending; at most 20 pending devices).
- If the portal is published on the internet, block `/iclock/` at the reverse proxy for
  everything outside the school network, or use "Only from address" on the device.
- Tables: `scan_devices`, `scans` (read-only by trigger), `scan_lessons`, `scan_corrections`,
  `scan_dismissals`; `users.scanner_pin`; `class_sessions.source` (`manual`, `scanner`, `correction`).
- Code: `src/scanner.js` (matching, `matchDay` is a pure function), `src/routes/iclock.js`,
  `src/routes/admin/scanner.js`, `src/routes/scans.js`. Tests: `test/scanner.test.js`.
