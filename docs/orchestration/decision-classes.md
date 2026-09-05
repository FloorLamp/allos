# Decision classes

Seven classes cover every question a lane could have asked at filing, from
the thirty issues that reached the owner mid-flight on 2026-09-04.

## Ask at filing

- **Two readings of one sentence.** The Fix and a requirement build different
  things: #5006 (seven logged groups or one), #4978 (the surface as form or
  route), #3295 (one tick per day or per event). Tell: restate each criterion
  in the Fix's own nouns; if two builds satisfy it, the issue is not filed.
- **Placement.** A new row, chip, block or button names its surface, its
  position, and what yields to it or duplicates it: #4712 (the derived Fever
  row rendered nowhere; the dose offer doubled the Meds chip), #5006 (block
  above or below the catalog), #4775 ("where is this button?").
- **A number.** A threshold, window or width is measured and cited, reuses a
  declared constant, or is labelled a guess: #5020 (the run floor became
  `FRAGMENT_MERGE_GAP_MAX_MIN`), #4974 (1280 was unbuildable, 1640 was the
  first width that paid), #3369 ("20–30 statements" was one), #4932 (60 s).
- **Wrong-result cost.** A write, delete, collapse or tombstone says what a
  false positive loses and whether undo reaches it: #5020 (a real nap deleted
  at ingest), #5021 (a re-time with no way back), #5028 (held for exactly
  this). The refusal direction is the default; the issue says so.
- **Two rulings on one name.** Search rulings by component, not by topic; two
  live rulings on one name are the owner's question before filing: #4978
  (`DoseConfirmButton` is primary under #3982 and a row affordance under
  #3408), #4950 (the chip the body specified collided with #4978's fence).
- **Coupled issues.** Two open issues on one component say which lands
  first: #4974 and #4973 each declared the other out of scope and were
  coupled by measurement; #4996's amendment depended on unlanded #5001.
- **Edges of an "every X" rule.** Name the surfaces that look like X and are
  not: #3899 (auth pages and `/offline` under the phone-frame rule), #5069
  (a shared reader narrowed for one caller). Real alternatives get 2–3
  costed options (#2837, #2830); the owner picks before filing.

## When one still reaches the owner

- **A visual A/B question carries screenshots.** Density, a primary's rank, a
  placement: the lane renders both options at 390 and 1280 and attaches them
  before the question is raised; prose alone does not reach the owner (#4978).
- **Attached means on the GitHub comment** (owner, 2026-09-05): the API takes
  no uploads, so the lane commits the PNGs under `screenshots/<issue>/` on its
  own branch, pushes it as any lane push and embeds each by its SHA-pinned raw
  URL. Never a session, an artifact page or an external host. The branch stays.

## Not catchable at filing

- **Owner amendments** after seeing the product (twelve spec edits, #3987,
  #4362, #4863): the owner's prerogative, recorded as body blocks.
- **Measured discoveries** that overturn a premise mid-lane (#5021's displaced
  trough, #5000's diagnosis, #4934's contention branch): the lane reports,
  the orchestrator rules or routes. Six stale premises closed by audit.
- **Process rules** (titles, receipts, banked slots, prod access) are the PM's.
