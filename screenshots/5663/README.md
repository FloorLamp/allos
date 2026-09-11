# The stool sheet's receipt rows (#5663)

Captured from `stool-row-states-it-5663` on the owner's 2026-09-11 ruling — the
sheet lists each of today's entries as its own receipt row, newest first, with
Undo on the newest and one count line beneath.

- The fixture is the e2e worker-0 seed with two Bristol readings on today: one
  seeded at 06:02 before the sheet opened, one tapped in the browser (type 6).
- `stool-390.png` is a 390 x 844 viewport, `stool-1280.png` a 1280 x 900 one.
  Both are the login's default 24-hour clock.
- `stool-390-12h.png` is the same capture with the login set to a 12-hour clock,
  so the trailing slot can be read as the owner wrote it. The app renders
  `1:48pm` — `formatClock`'s existing `lower-nospace` style. The ruling's own
  spelling is `8:31 am`, lowercase with a space, which no meridiem style in
  `lib/format-date.ts` produces; the closest alternative is `1:48 PM`
  (`upper-space`). That is an open copy question, not a decision taken here.
- At 390 the longest description wraps the facts line, so the newest row stands
  three lines tall; the Undo control keeps its own column beside it.
