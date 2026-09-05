# Standing rulings

The owner's and the PM's process rulings that bind every session: one bullet
each, dated, with the issue that taught it.

The Ladder issue (#4769) carries STATE — rungs, slices, landing order — and
points here. A ruling about one issue lives in that issue's body, never here.

## Landing

- Merges are serial, PRs are not (owner, 2026-09-02): a branch that passed
  its gates opens READY at once; only the merge is serial.
- A release-notes batch landing on `main` does not by itself force a merge-in
  and re-run of a PR that never touches `lib/release-notes.json` (PM, low
  impact, 2026-09-03): the file is display data read by one page.
- A receipt survives a byte-identical merge-in (PM, low impact, 2026-09-03):
  when the head moved only because `main` was merged and the three-dot diff
  is unchanged, the exact-head receipt stands with the equality shown (#5247).
- A PR the owner opens gets a plain non-author review and the standard gates
  (owner, 2026-09-04); a blocker is fixed as a new commit on the owner's
  branch, stated on the PR — never rebase, amend or force-push it.
- Two falsifying passes per PR; a third falsification means SIMPLIFY the
  guards, the code, or both — never a third round (owner, 2026-09-05).
  Pass-three prose or claim mismatches become follow-ups unless they mask a
  leak; a mechanism change still voids the standing pass (#5203's seven).

## Dispatch

- No lane or session touches prod (owner, 2026-09-03): no replay, backfill,
  snapshot read or migration run. A lane states what the owner would run and
  what it recovers; the owner runs it.
- A per-session rate-limit rejection kills every agent at once and is a
  pause, not a wind-down (PM, low impact, 2026-09-05): banked branches
  survive; after one, run FOUR agents per session, passes included, until a
  five-hour window passes clean, then five (`dispatch.md` §Dispatch).
- Duplicate filings: one bug, one lane — the earlier CLAIM holds, not the
  earlier file (PM, 2026-09-04; #5241 over #5242).
- Extract, don't copy (owner, 2026-09-04, #5144): a lane touching a shape
  #5144 names extracts it and records on #5144 which item moved.

## Homed elsewhere

- A MERGE-HOLD is a gate until lifted; whose PR a landing slot is; quoted
  markers — `claims.md`.
- Banked lanes hold no slot; a receipt is a review, never a lane —
  `multi-orchestrator.md` §Slots.
- A visual A/B question carries screenshots at 390 and 1280 —
  `decision-classes.md`.
- Titles: one clause, 72 characters, issues state a truth, PRs are imperative
  — `dispatch.md` §Per-unit pipeline and the file-issue skill.
- The ~90% weekly usage wind-down is the owner's call — the pm skill.
- Consumables are events with an instant; day totals are rollups —
  `docs/internals/substances.md`.
