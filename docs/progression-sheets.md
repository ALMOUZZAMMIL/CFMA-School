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
