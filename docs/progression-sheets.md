# Progression sheets and the curriculum tracker

## Progression sheets (Fiches de progression)

1. **The teacher writes the sheet.** Under *Progression sheets* a teacher sees one line per
   subject and level they teach. "Create my sheet" starts a **draft**. They add chapters and
   lessons with the date each lesson should be reached (or paste them from Excel).
2. **"Submit and lock".** From then on nobody can change or delete anything on the sheet,
   not the teacher and not the administration.
3. **Changing a locked sheet.** The teacher presses "Ask the administration to change it" and
   gives the reason. The request appears under *Progression sheets → Requests* (the menu shows a
   counter). The administration approves it for 24 h, 48 h, 3 days or a week, or refuses it with
   a reason. While the window is open only that teacher can edit; it locks itself again at the
   end, or when the teacher presses "I have finished: lock the sheet again".
   The administration can also open a sheet for itself, with a reason.
4. **History.** Every sheet shows its full history at the bottom: who created it, when it was
   locked, each request and decision, and every lesson added, changed (old → new date or title)
   or deleted.

Official programmes imported with `npm run import-school-data` start locked. An import never
overwrites a sheet that a teacher submitted.

## Curriculum tracker (Suivi du programme)

For each class and subject, on any date:

- **Should be on**: the first lesson not yet finished, according to the locked sheet.
- **Reached**: the last lesson the teacher recorded as taught (under *Curriculum tracker → Open →
  Record progress*).
- **Status**: *on track*, *behind* (a lesson due more than 7 days ago is not finished) or
  *far behind* (more than 21 days). Both numbers can be changed in *Settings → Curriculum tracking*.

The page lists the classes behind first, counts them, and shows which teachers have classes behind
and by how much. A sheet that is still a draft shows as *sheet not submitted*.

**Who is teaching what now?** (button on the tracker) lists every class on the timetable for a
day, highlights the classes in session at the current time, and for each one shows the lesson
that should be taught, the lesson reached, and whether the class was recorded as held.

## Upload windows (each term)

Under *Progression sheets → Upload windows*, the administration sets, for each term, the dates
during which teachers may upload or complete their sheet for that term. While a term's window is
open, a teacher can add and change the chapters and lessons **of that term** even on a locked sheet
(other terms, and lessons already taught, stay locked), then presses "Hand in and lock". Outside the
windows teachers cannot write; changes then need an approved request. Leave the dates empty for no limit.

## Durations and dates

Each lesson can have a time to finish: 1, 2 or 3 days, 2 to 3 days, 1 week, 1 to 2 weeks,
2 weeks, 2 to 3 weeks, 3 or 4 weeks (counted in school days). "Work out the dates" gives every
lesson a start and finish date, one after the other, skipping weekends, holidays and exam periods.
For "1 to 2 weeks" the finish date is the latest one (2 weeks).

## Exam timetable

*School calendar → Exam timetable* lists the exam periods (from the calendar file, plus any added
there). For each one, choose whether lessons stop. When they stop, those days are skipped when dates
are worked out and are not counted in delays, so a teacher is not marked late because of exams.
The exam periods of the term are shown at the top of the timetable, and each lesson on the timetable
shows the lesson the class should be on (⚠ when it is behind).
