# Queue labels

Two axes are load-bearing; `reconcile-tracker` flags violations of both
(`checkLabelHygiene`, 2026-08-15):

- **Exactly one priority-slot label**: `P0`–`P3` or `parked`. Never two — a
  `P2` + `parked` issue is in no queue and every queue at once.
- **At least one domain label.** Cross-cutting design/UX work takes `design` —
  a real domain, not a missing one.
- Every ready P0/P1 preempts feature and presentation work, with or without
  `bug`. Other type labels (`feat`, `refactor`, `testing`, `a11y`) are
  optional color; `ui` marks e2e-heavy work.
- **The taxonomy is CLOSED; its canon is `KNOWN_LABELS`** in
  `scripts/work/reconcile-tracker-core.ts`. Verify labels against the
  constant, never the live list — the add-labels endpoint silently mints
  unknown labels, so the live list validates past mistakes.
- A missing concept is an owner decision, never a new label. Ruled 2026-08-30:
  `testing`/`a11y` promoted as type color, `dashboard` as a domain, a size
  axis DECLINED (the dispatch ledger already measures real durations).
- `checkLabelHygiene` flags `unknown-label` and retired labels;
  `.github/workflows/label-taxonomy.yml` deletes strays repo-side. To add a
  label, extend `KNOWN_LABELS` and merge first — the live list follows code.
- `needs-human` means one owner answer is required. Label + assign, keep
  working elsewhere; never prompt the owner uninvited and never a blocking
  `AskUserQuestion` mid-session — the owner is usually absent. The
  needs-human skill drains the queue when they show up.
- A `needs-human` comment is shaped for the fastest answer: the options, a
  recommendation, each option's size, and what the answer unblocks. A wording
  question proposes the wording. Ripeness test: does the answer change code
  or a ruling? If not, it is a note, not a question.
- State whether the answer is VISIBLE to a person (copy, layout, a control,
  a reach, where data lands). Visible answers wait for the owner; the rest
  the PM rules on the recommendation (`.claude/skills/pm`).
- Evaluations end with `recommend-adopt` or `recommend-hold`. A hold also gets
  `parked`; an adopt is merged by the worker.
