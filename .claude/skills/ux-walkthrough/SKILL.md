---
name: ux-walkthrough
description: Launch Allos against a scratch DB and drive the real UX journeys (fresh-install onboarding, email invite, all-pages census, common workflows) with a screenshot at every step. Use when asked to run the app, review UX end-to-end, or see what a flow actually looks like — not for assertions (those belong in e2e specs).
---

# UX walkthrough

Drive the real app and _look_ at it. The harness is `scripts/ux-walkthrough.mjs`
— a seeing tool, not a test tier. Journey assertions belong in `e2e/*.spec.ts`.

## 1. Launch the app on a scratch DB

NEVER point this at a real `data/allos.db`. Run from the repo root:

```bash
ALLOS_DB_PATH=/tmp/ux-walkthrough.db \
ADMIN_USERNAME=admin ADMIN_PASSWORD=first-boot-pw-1 \
EMAIL_TEST_CAPTURE=/tmp/ux-mail.jsonl \
PORT=3111 npm run dev
```

- `ALLOS_DB_PATH` at a fresh path = a true first-install: bootstrap admin
  from the env creds, empty DB, onboarding wizard from scratch.
- `EMAIL_TEST_CAPTURE` (`lib/email.ts`) appends every outbound email as a
  JSON line instead of contacting SMTP — the invite journey reads the
  set-password link from it. SMTP values must still be configured (fakes
  fine) plus the public URL; the harness does that on Settings → Server.
- **First-request patience:** after "Ready", the first hit still compiles
  middleware + page — minutes on a slow filesystem. Poll `/login` for a 200
  before driving.

## 2. Drive the journeys

Easiest: let the harness own the server lifecycle. `--serve` boots the dev
server on a unique private scratch DB, polls readiness, and tears both down;
a caller's `ALLOS_DB_PATH` is ignored in this mode.

```bash
node scripts/ux-walkthrough.mjs --serve onboarding invite pages workflows
```

Or run against an already-running server (section 1) without `--serve`.
Seed shapes (`UX_SEED=1|thin|dirty|one-cycle`) are §3's table.

Journeys: `onboarding`, `invite`, `pages` (all-routes census, both widths),
`workflows` (search + quick-logs), `live`, `dismiss`, `dose`, `profiles`,
`upload`. Every run writes an `index.html` contact sheet for fast review.

- Run `onboarding` first on a fresh DB — it saves the admin session state
  the later journeys reuse.
- `pages` auto-enumerates every `app/(app)` route and screenshots each at
  desktop (1280×900) and mobile (390×844).
- Dynamic `[param]` routes are censused too (#1544):
  `scripts/ux-census-routes.mjs` gives each pattern one instance — a literal
  slug off a static enum, or the first detail link found on an index route
  (which also proves index → detail works).
- Shots and `metrics.json` rows are keyed by the PATTERN, not the resolved
  id, so `--baseline` diffing survives a reseed; the resolved URL rides in
  the row's `resolved` field.
- An unresolvable pattern logs `BLIND SPOT` and lands in `audit.md`'s
  "Unreached dynamic routes" table — never silently dropped.
  `ux-census-routes.test.ts` fails when a new dynamic route lacks an entry.
- **Tab-hub blind spot**: `pages` shoots each route at its DEFAULT tab, so a
  `?tab=` hub's metrics describe that one tab. Attribute metrics to the tab,
  name it when filing, never rank a hub against plain pages without the
  caveat (#2566 tracks teaching the harness non-default tabs).
- **Disclosure expansion (#2616)**: a surface that collapses its content by
  default registers in `DISCLOSURE_EXPANSIONS` and gets a SECOND capture,
  `…-expanded.png`, after every closed toggle is clicked open — where
  identity splits and label leaks show. Default shot and metrics untouched.
- A registered route with nothing to expand logs `BLIND SPOT`; redirecting
  routes record `landedOn` and an "Alias routes" table, so byte-identical
  shots are attributable. The registry test pins routes and `data-testid`s.
- **Committed chrome baseline (#3390)**: `scripts/census-chrome-baseline.json`
  records the shell's rendered geometry for five routes at both viewports —
  the file #1510's "re-annotate the census baseline" always assumed existed.
- A `pages` run compares the surfaces it recognises and prints a "Committed
  chrome baseline" table in `audit.md`, naming any surface it did not reach
  so a scoped run cannot read as a full one. Advisory only.
- The file is ENFORCED by `e2e/census-chrome-baseline.spec.ts`, the only
  thing that may write it: `npm run gen:census-baseline`, commit the diff —
  the diff IS the annotation. Never hand-edit a number
  (`census-chrome-baseline.test.ts` checks canonical form).
- Screenshots land in `data/ux-shots/` (gitignored) unless `UX_SHOTS`
  overrides. Playwright cache miss → set `UX_CHROMIUM` (in Claude Code
  remote: `/opt/pw-browsers/chromium`).
- Knobs: `UX_BASE`, `UX_ADMIN_USER`/`UX_ADMIN_PASS` (must match the server
  env), `UX_TIMEOUT_MS`, and `UX_ROUTES` — a comma-separated route/prefix
  filter for `pages` (e.g. `UX_ROUTES=/trends` audits one hub).

## 3. Review

Read the screenshots in sequence — numbered in drive order. A blank frame is
a failed render, not a passed step. When a journey logs `FAILED` or "check
shots", look at that shot before concluding anything.

### Reviewing a full census (100+ shots): fan out, don't read serially

1. **Validate the capture set FIRST**:
   `md5sum *desktop*.png | awk '{print $1}' | sort -u | wc -l` — near-1
   unique hashes means an unauthenticated pass (58 identical /login shots
   once read as a completed census). Duplicates should match "Alias routes".
2. **Dispatch 3–4 territory reviewer subagents**, each owning ~15–20 shots,
   with the exact file list and the house conventions: one PageHeader h1 +
   subtitle, sentence case, frosted cards, `section-label` groups, one date
   format per context, friendly empty states.
3. **Dispatch one cross-page consistency reviewer** with the generated
   `consistency.html` — one DEFAULT desktop capture per reached route, low
   zoom, no mobile/expanded/hover, so every tile is comparable. It reports
   only BETWEEN-page drift: chips, buttons, stat tiles, arrows, link colors.
4. **Name every review dimension in every brief** — hierarchy / text /
   layout, plus the ones prior reviews silently dropped:

   - **Density** — information and control density against peer surfaces.
   - **Inset stacking** — cards in cards, doubled gutters, competing
     boundaries.
   - **Copy jargon** — terms a regular person would not use.
   - **State honesty** — claims stronger than the visible sample supports.

   The consistency lane also names **control grammar** (step 3's checklist);
   `ux-consistency-review.test.ts` pins this vocabulary.

5. **Tell reviewers which artifacts to EXCLUDE**: the dev-overlay "1 Issue"
   badge, and any position:fixed bar smeared mid-image by fullPage capture
   (a screenshot artifact, though its presence may deserve its own look).
6. **Require refutability**: name the route and the exact visible defect,
   list routes that look GOOD (proves coverage), end with a top-5.
   Cross-check surprising claims against code before filing.
7. **Run all five census shapes** — they surface disjoint finding sets, and
   a whole class of degradation lives only in the middle states:

   | shape     | command                                                           | what it shows                        |
   | --------- | ----------------------------------------------------------------- | ------------------------------------ |
   | fresh     | `node scripts/ux-walkthrough.mjs --serve pages`                   | empty states                         |
   | thin      | `UX_SEED=thin node scripts/ux-walkthrough.mjs --serve pages`      | a phone's first week                 |
   | seeded    | `UX_SEED=1 node scripts/ux-walkthrough.mjs --serve pages`         | ~3 weeks, full tables/charts         |
   | dirty     | `UX_SEED=dirty node scripts/ux-walkthrough.mjs --serve pages`     | portal residue + uncontrolled names  |
   | one-cycle | `UX_SEED=one-cycle node scripts/ux-walkthrough.mjs --serve pages` | one completed-cycle honesty boundary |

Shape notes, each load-bearing when reading a run's receipts:

- **Dirty (#3489)** is a named fixed vector, not a numbered random look:
  baseline continuity plus `importQuirks`, `textLength`, and the long-name
  corpus (`scripts/seed-long-names.ts`). Never combined with `SEED_RNG`;
  `run.json` records `UX_SEED=dirty` + `SEED_DIAL_SHAPE=dirty`.
- **One-cycle (#3489 D5)** stores exactly two periods 28 days apart — one
  completed interval, deliberately below the three-sample honesty gate:
  `/medical/cycles` shows the "appears after 3" line, no stat tiles;
  `run.json` records `SEED_DIAL_SHAPE=one-cycle`.
- The `middleState` dial is a named-shape registration point: numbered
  `SEED_RNG` looks keep their baseline value; future threshold−1 states
  register there rather than shifting existing seed vectors.
- **Entropy (#2594)**: `seeded`/`thin` also take `SEED_RNG=<int>` for a
  reproducible alternate look — a seeded PRNG samples five scenario dials,
  each mapped to a defect class the baseline can't show. Unset = the pinned
  baseline.
- `run.json` + the audit header record both knobs; `--baseline` warns
  loudly on shape mismatch instead of printing false regressions. Sweep 2–3
  seeds when hunting; keep one when diffing.
- `SEED_RNG` without `UX_SEED=1|thin` fails loudly (a fresh DB cannot hold
  the vector); combining with `SEED_PERSONA` fails too — persona data
  replaces the dial vector, and the receipt must not claim phantom entropy.
- **The unbounded-name corpus (`SEED_RNG=3`, #3631)** is the dial for
  GEOMETRY audits: a control sized by data nobody chose cannot be caught by
  a census whose longest label fits any phone — how #3478 hid.
- The corpus roster is `scripts/seed-long-names.ts`; add an entry when you
  ship a control sized by user-uncontrolled data.

  ```bash
  SEED_RNG=3 UX_SEED=1 node scripts/ux-walkthrough.mjs --serve pages
  ```

- **A clean geometry table means one of two things**, and they read
  identically: nothing is broken, or nothing in the corpus could be. Say
  which — the run's own `SEED_RNG` line in `audit.md` is the answer.
- **Thin (#1544)** seeds then trims dated stores to ~7 days
  (`UX_THIN_DAYS`) — the point where the 7/30/90-day windows COINCIDE, a
  state neither pole reproduces (#1541). The clinical passport is kept so
  detail pages still resolve ids. Every `--serve` run gets a fresh DB.
- **Personas (`SEED_PERSONA`)** swap WHO profile 1 is
  (`scripts/seed-personas.ts`) — coherent alternate characters aimed at the
  surfaces their demographics affect (growth charts, pediatric BP, elderly
  norms, polypharmacy). Needs `UX_SEED=1`; an unknown name FAILS the run.

  ```bash
  SEED_PERSONA=household UX_SEED=1 UX_ROUTES=/household,/upcoming,/history \
    node scripts/ux-walkthrough.mjs --serve pages
  ```

  | persona           | who                                                                    | most-affected targets                     |
  | ----------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
  | `bodybuilder`     | 28M, heavy 4-day split                                                 | /training /progress /nutrition /longevity |
  | `marathon-runner` | 34F, marathon block, Strava + Health Connect (one run from both)       | /training /equipment /integrations /data  |
  | `household`       | caregiver over 4 profiles: 40M rising LDL, 76F on 6 meds, sick twins   | /household / /upcoming /history /records  |
  | `pregnant`        | 31F ~20wks: PHQ-9, ultrasounds, carrier variants; 15-year-old daughter | / /medical/cycles /upcoming /records      |
  | `diabetic-cgm`    | 52M dense glucose + docs; partner with chronic asthma + docs           | /medications /results /upcoming /data     |
  | `biohacker`       | 36M, 20 supplements, 3 practices, Oura + Withings                      | /nutrition /longevity /sleep /history     |

- Several personas are multi-profile households (profile 1 acts; members are
  created by the persona) and several carry `connected` integrations with
  credential-less configs — sync degrades gracefully while /integrations
  reads connected.
- Some exist partly to make a GAP visible (registry `gaps`): no
  gestational-age model (#1402), no CGM stream (#2810), no fasting surface
  (#2756) — expect those absences and report them as findings, not census
  failures.
- The pages census drives only profile 1; members' own pages need an
  acting-profile switch the harness does not yet parameterize. Unit guards:
  `seed-personas.test.ts` (registry), `__db_tests__` (live schema).

### Live screenshots outrank the census

The census's data is clean by construction; a whole defect class exists
only in a lived-in profile — frecency interference, import quirks
(" - Primary" baked into a name), label leaks, ordering regressions.

When the owner posts a screenshot of their real app, treat it as first-class
audit input: the 2026-08 sweep's highest-value bugs all came from two such
shots, none from the seeded census.

### Trace every symptom to its mechanism before filing

The first plausible mechanism is often wrong, in both directions:

- A jumbled dose order read as "bucket sort is alphabetical" — every #297
  layer was correct; the real cause was the multi-profile merge comparator
  dropping `compareWithinBand`'s tiebreaks. The first hypothesis would have
  sent the fix to the wrong module.
- "Fever on the Cycle page" read as a category error — it is deliberate
  (the bar is the day's one symptom ledger), and the honest fix was a
  framing line, not a filter. Check whether the "bug" is a documented
  design; the fix for those is copy.

Both directions end the same way: name the file:line mechanism in the issue,
or don't file yet.

## From findings to filings

The loop that survived owner contact, for anything bigger than a point bug:

1. Verify each visible defect in code (above), separating defects from
   design choices from owner calls.
2. Ship a **compact clickable prototype** of the redesigned surface — a
   single-theme artifact in the app's own dark look, real `<details>`
   disclosures. Owner feedback was explicit: prototypes over design essays.
3. Before proposing a structural change, search closed/open issues for
   standing owner rulings — several surfaces are pinned by decision, and a
   proposal that re-litigates one burns the review.
4. File **self-contained issues**: artifact URLs are private-by-default, so
   the body carries the full diagnosis and direction. Bugs and redesigns
   file separately; resolved owner calls recorded as resolved.

## Mobile audit (metrics + tap costs, #1510)

The harness also MEASURES — same seeing-tool ethos. Three artifacts next to
the contact sheet:

- **`metrics.json`** (`pages`): per route × viewport — page height,
  first-data offset, table/form/overflow-menu counts, h1-scale headings, a
  findings-flood heuristic (≥4 sibling cards sharing a 24-char prefix).
- Plus the **geometry probes (#3489)**: `clipped` (a rendered box exiting
  the viewport with no designed scroller reaching it), `heightRows`
  (interactive controls in one row differing >2px), and `overlaps` (#3814 —
  text boxes one container painted on top of each other, reported as RECTS).
- A heading above a paragraph reads as one string through `textContent` and
  is NOT a collision — the evidence is the boxes. All three lists carry the
  count they were truncated from, so a capped list is never silent.
- **`taps.json`** (`workflows`, `dose`, `dismiss`, `profiles`): tap costs
  per action. A tap = one pointer gesture; typing one field = one "input".
  Reach costs come first, driven through the real mobile drawer; action
  spans are SURFACE-LOCAL, so total cost = reach + action.
- Unmeasurable steps record a note, never a guess. Not every #1510 action
  has a journey yet (household confirm, star) — gaps stay visible in the
  table; add journeys to close them.
- **`audit.md`**: the ranked report — render faults and unreached dynamic
  routes first, then the two geometry tables, then first-data offsets,
  tallest pages, standing forms, flood/multi-h1, the tap table.

**Geometry (#3489)** ranks above the page-level tables because it names a
broken ELEMENT, both viewports covered — a contact sheet cannot show a 4px
height difference.

Three such defects were found by eye after every prior census had
photographed them (#3478, #3481, #3486).

A sweep that reports text instead of boxes files findings nobody can falsify
(#3716 filed a "collision" that was two correctly stacked blocks, #3814).

Read the tables as leads, not verdicts — a `clipped` span may be designed
truncation. The rule is `scripts/ux-geometry-census.mjs`.

That it sees a planted offender and stays quiet on designed scrollers is
asserted in `e2e/ux-geometry-probe.mobile.spec.ts`, the only part in CI.

**Render health (#1544)**: the probe records `renderFault` — `not-found` or
`error-boundary`. Both render INSIDE the app shell, so their shots look
plausible and their metrics measure nothing real; read that table first.

**Regression tracking**: `--baseline <prior shots dir>` diffs metrics/taps
into audit.md. Growth **>15%** in firstData/height flags a route; **ANY +1
tap** flags an action — step-function damage.

Annotate a deliberate trade on the new baseline (#1509) rather than
suppressing the flag.

### Post-merge mini-census

Run a seeded mini-census while a merged UI change is still fresh:

```bash
UX_SEED=1 node scripts/orchestration/post-merge-census.mjs HEAD^ HEAD --run
```

It maps Git's changed files `app/(app)/X/**` → `UX_ROUTES=/X`, validating
each prefix against the route tree. Shared chrome (`components/**`, layouts,
`app/globals.css`) runs the whole set — nothing defends a narrower claim.

A renamed/deleted route, unknown `app/` shape, or diff with no censused UI
target stops loudly for a manual plan.

`--run` gives the harness a unique owned scratch DB, removed afterward;
without it the plan prints, preserving `UX_SEED`/`SEED_RNG`/`SEED_PERSONA`.

The target vocabulary for filings: first data inside one viewport-height; no
standing rare-cadence entry forms (#1497); nothing unrolls unbounded
(#1496/#1504); one h1-scale heading per page (#1449).

## Extending

A new dynamic route needs a `DYNAMIC_ROUTES` entry in
`scripts/ux-census-routes.mjs` — `follow` preferred (survives id churn, proves
index → detail); `literal` only for `lib/` enum slugs. A unit test enforces it.

Add a workflow by copying the shape in `workflowsJourney` (short, honest
steps; log loudly when a step can't complete). New journeys register in the
`journeys` map.

Wrap a new action's gestures in `beginTaps`/`tapClick`/`tapFill`/`endTaps`
so it joins `taps.json` — closing the span on every failure branch, or the
count leaks into the next action.
