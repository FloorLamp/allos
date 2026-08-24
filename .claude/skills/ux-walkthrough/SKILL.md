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

- `ALLOS_DB_PATH` at a fresh path = a true first-install (bootstrap admin from
  the env creds above, empty DB, onboarding wizard from scratch).
- `EMAIL_TEST_CAPTURE` (see `lib/email.ts`) appends every outbound email as a
  JSON line to that file instead of contacting SMTP — the invite journey reads
  the set-password link from it. SMTP host/port/from must still be _configured_
  (any fake values) plus the public URL; the harness does that itself on
  Settings → Server.
- **First-request patience:** after "Ready", the first hit still compiles
  middleware + page; on a slow filesystem that can take minutes. Poll until
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:3111/login` returns
  200 before driving.

## 2. Drive the journeys

Easiest: let the harness own the server lifecycle (`--serve` boots the dev
server on the scratch DB, polls readiness, and tears it down; `UX_SEED=1`
runs `scripts/seed.ts` first for a data-rich census, `UX_SEED=thin` seeds and
then trims to the last ~7 days, and `UX_SEED=dirty` pins import residue plus
long uncontrolled names — see the four shapes in §3):

```bash
node scripts/ux-walkthrough.mjs --serve onboarding invite pages workflows
```

Or run against an already-running server (section 1) without `--serve`.

Journeys: `onboarding`, `invite`, `pages` (all-routes census, both widths),
`workflows` (search + quick-logs), `live` (live workout mode), `dismiss`
(finding dismissal persistence), `dose` (dose confirm persistence),
`profiles` (acting-profile switch + read-only member), `upload` (medical
document, offline path). Every run writes an `index.html` contact sheet next
to the shots for fast human review.

- Run `onboarding` first on a fresh DB — it saves the admin session state the
  later journeys reuse.
- `pages` auto-enumerates every `app/(app)` route from the filesystem and
  screenshots each at desktop (1280×900) and mobile (390×844) widths. Dynamic
  `[param]` routes are censused too (#1544): `scripts/ux-census-routes.mjs` gives
  each pattern one instance — a literal slug off a static enum
  (`/trends/metric/weight`, `/immunizations/tdap`) or the first detail link found
  on an index route (which also proves index → detail works). Shots and
  `metrics.json` rows are keyed by the PATTERN, not the resolved id, so
  `--baseline` diffing survives a reseed; the resolved URL rides along in the
  metrics row's `resolved` field. A pattern the harness cannot resolve — no
  registry entry, or an empty list on a thin/fresh shape — logs `BLIND SPOT` and
  lands in the "Unreached dynamic routes" table in `audit.md`; it is never
  silently dropped. `lib/__tests__/ux-census-routes.test.ts` fails the unit tier
  when a new dynamic route ships without a registry entry.
- **Tab-hub blind spot**: `pages` shoots each route at its DEFAULT tab only, so a
  `?tab=` hub's metrics describe that one tab — /training's firstData is the Log
  tab's, not Overview's. Attribute metrics to the tab, name it when filing, and
  never rank a hub against plain pages without the caveat (#2566 tracks teaching
  the harness non-default tabs).
- **Disclosure expansion (#2616)**: a surface whose default state collapses its
  content (the readings catalog's panel groups) registers in
  `DISCLOSURE_EXPANSIONS` (`scripts/ux-census-routes.mjs`) and gets a SECOND
  capture, `…-expanded.png`, taken after every closed toggle is clicked open —
  that shot is where identity splits and label leaks show. The default shot and
  its metrics row are untouched, so `--baseline` diffs stay comparable; a
  registered route with nothing to expand logs `BLIND SPOT`. Redirecting routes
  record `landedOn` in their metrics row and an "Alias routes" table in
  `audit.md`, so byte-identical shots are attributable. The registry test pins
  routes and `data-testid`s, so a rename fails the unit tier, not the next run.
- **Committed chrome baseline (#3390)**: `scripts/census-chrome-baseline.json`
  records the shell's rendered geometry — rail width, gutters, reading-column
  width, content offset, top-bar and dock heights, title box — for five routes at
  both census viewports. It is the file #1510's "re-annotate the census baseline"
  criterion always assumed existed; before it, `metrics.json` was a run artifact
  and there was nothing in the tree to annotate. A `pages` run compares the
  surfaces it recognises and prints a **Committed chrome baseline** table in
  `audit.md`, naming any surface it did not reach so a scoped run cannot read as a
  full one. That table is advisory. The file is ENFORCED by
  `e2e/census-chrome-baseline.spec.ts` against the pinned e2e fixture, which is
  also the ONLY thing that may write it: regenerate with
  `npm run gen:census-baseline` and commit the diff — that diff IS the annotation.
  Never hand-edit a number; `lib/__tests__/census-chrome-baseline.test.ts` checks
  the file is still in the writer's canonical form, floors it per viewport, and
  walks `app/(app)` to confirm every recorded route still exists.
- Screenshots land in `data/ux-shots/` (gitignored) unless `UX_SHOTS` overrides.
- If Playwright can't find its browser build (version-pinned cache miss), set
  `UX_CHROMIUM` to a Chromium binary — in Claude Code's remote environment that
  is `/opt/pw-browsers/chromium`.
- Knobs: `UX_BASE` (default `http://localhost:3111`), `UX_ADMIN_USER`/
  `UX_ADMIN_PASS` (must match the dev-server env above), `UX_TIMEOUT_MS`
  (per-page default timeout, for slow first-compiles), and `UX_ROUTES` — a
  comma-separated route/prefix filter for `pages` (e.g. `UX_ROUTES=/trends`
  audits one hub and its subroutes instead of the full census).

## 3. Review

Read the screenshots in sequence (`index.html` is a thumbnail contact sheet) —
they are numbered in drive order. A blank frame means a failed render, not a
passed step. When a journey logs `FAILED` or "check shots", look at that shot
before concluding anything about the flow.

### Reviewing a full census (100+ shots): fan out, don't read serially

The proven workflow for an all-pages consistency audit:

1. **Validate the capture set FIRST**: `md5sum *desktop*.png | awk '{print $1}'
| sort -u | wc -l` — near-1 unique hashes means the pass ran unauthenticated
   (it once produced 58 identical /login screenshots that read as a completed
   census). The harness now aborts loudly on auth failure, but verify anyway;
   duplicates should correspond only to the audit.md "Alias routes" table's
   rows (routes recorded as landing on another path).
2. **Dispatch 3–4 territory reviewer subagents**, each owning ~15–20 shots
   (split the full-size desktop captures alphabetically; one agent takes a
   mobile sample). Give each the exact file list and the house conventions to
   judge against: one PageHeader h1 + subtitle, sentence case, frosted cards,
   `section-label` field groups, one date format per context, and friendly empty
   states.
3. **Dispatch one cross-page consistency reviewer** with the run's generated
   `consistency.html`, not a list of every raw screenshot. The artifact is the
   tractable view: exactly one DEFAULT desktop capture per reached route, all at
   low zoom; it excludes mobile, expanded, and hover states so every tile is
   comparable. The reviewer reports only BETWEEN-page drift and uses the pinned
   control checklist: chips, buttons, stat tiles, arrow glyphs, and link colors.
   Clicking a candidate opens its full-size shot for verification. This is one
   reduced artifact, so it does not break the 15–20-shot territory cap.
4. **Name every review dimension in every brief.** Keep hierarchy / text /
   layout, and add the dimensions prior reviews silently dropped:

   - **Density** — information and control density compared with peer surfaces.
   - **Inset stacking** — cards in cards, doubled gutters, and competing
     boundaries.
   - **Copy jargon** — terms a regular person would not use or understand.
   - **State honesty** — claims stronger than the visible sample or state
     supports.

   The consistency lane also names **control grammar** using the checklist in
   step 3. `lib/__tests__/ux-consistency-review.test.ts` pins this vocabulary and
   the artifact's default-desktop-only selection rule.

5. **Tell reviewers which artifacts to EXCLUDE** or they'll report them as
   findings: the dev-overlay "1 Issue" badge (dev-only chrome) and any
   position:fixed bar smeared mid-image by fullPage capture (a fixed element
   renders once at an arbitrary scroll position — its mid-page "occlusion" is a
   screenshot artifact, though its presence may itself be a bug worth a
   separate look).
6. **Require refutability**: reviewers must name the route and the exact visible
   defect ("two identical ⋯ buttons at x1170/x1225"), list routes that look
   GOOD (proves coverage), and end with a top-5. Cross-check surprising claims
   against the code before filing (a "dead route" may be an intentional
   relevance redirect).
7. **Run all four census shapes** — they surface disjoint finding sets, and a
   whole class of degradation lives only in the middle one:

   | shape  | command                                                       | what it shows                       |
   | ------ | ------------------------------------------------------------- | ----------------------------------- |
   | fresh  | `node scripts/ux-walkthrough.mjs --serve pages`               | empty states                        |
   | thin   | `UX_SEED=thin node scripts/ux-walkthrough.mjs --serve pages`  | a phone's first week                |
   | seeded | `UX_SEED=1 node scripts/ux-walkthrough.mjs --serve pages`     | ~3 weeks, full tables/charts        |
   | dirty  | `UX_SEED=dirty node scripts/ux-walkthrough.mjs --serve pages` | portal residue + uncontrolled names |

   **Dirty profile (#3489)** is a named, fixed vector rather than a numbered
   random look: it keeps illness, volume and logging continuity at the baseline,
   turns on the existing `importQuirks` and `textLength` hooks, and runs the
   existing long-name corpus in `scripts/seed-long-names.ts`. Do not combine it
   with `SEED_RNG`; the harness fails instead of recording two conflicting shape
   labels. `run.json` and the audit header record both `UX_SEED=dirty` and its
   fixed `SEED_DIAL_SHAPE=dirty` receipt.

   **Entropy (#2594)**: the `seeded` and `thin` shapes also take
   `SEED_RNG=<int>` for a
   distinct, REPRODUCIBLE look — a seeded PRNG samples five scenario dials
   (past/active illness, import quirks, heavy goal volume, logging gaps, long
   names), each mapped to a defect class the seeded baseline can't show. Unset
   = the pinned baseline (what e2e and old baselines expect). The run's
   `run.json` + the audit header record both knobs, and `--baseline` prints a
   loud shape-mismatch warning instead of a wall of false regressions when
   seeds differ. Sweep 2–3 seeds when hunting; keep one seed when diffing.

   **The unbounded-name corpus (`SEED_RNG=3`, #3631)**: the `long names` dial is
   the one to reach for when auditing GEOMETRY, and it is worth knowing why. A
   control whose intrinsic width is set by data nobody chose — a `select` of item
   names, a chip carrying a portal-imported title, a cell holding a lab analyte's
   full name — cannot be found by a census whose longest medication label is
   `Atorvastatin (inactive)`, 23 characters, which fits a phone at any width. That
   is what happened to #3478: the geometry probe was never blind, the corpus was.
   `SEED_RNG=3` is "past illness + long names", the smallest seed that turns the
   dial on with the least other perturbation:

   ```bash
   SEED_RNG=3 UX_SEED=1 node scripts/ux-walkthrough.mjs --serve pages
   ```

   The values it plants, the data families that still need one, and the controls
   each family sizes are the roster in `scripts/seed-long-names.ts` — read it
   before concluding a geometry census came back clean, and add an entry there
   when you ship a control whose width comes from user-uncontrolled data.

   **A clean geometry table means one of two things**, and they read identically:
   nothing is broken, or nothing in the corpus could be. So when a run reports no
   clipped elements, say which — the run's own `SEED_RNG` line in `audit.md` is
   the answer, and an unset one has NOT exercised this class.

   `UX_SEED=thin` (#1544) runs `scripts/seed.ts` and then
   `scripts/ux-thin-data.ts`, which trims every dated observation store to the
   last ~7 days (`UX_THIN_DAYS` overrides). Seven days is the point where the
   trailing 7/30/90-day windows COINCIDE, so a period-stats card shows the same
   number three times — fresh reads "No data" three times and the full seed
   separates the 7d window, so neither pole reproduces it (#1541). The clinical
   passport (encounters, records, immunizations, procedures, preventive events)
   is deliberately kept: a week-old install can hold years of it from one
   document import, and keeping it lets the detail-page census still resolve ids
   on this shape. Use a scratch `ALLOS_DB_PATH` per shape, or delete the DB
   between runs — the seed refuses a non-empty database.

   **Personas (`SEED_PERSONA`)**: the seeded shape can also swap WHO the
   profile is — `scripts/seed-personas.ts` seeds a coherent alternate
   character for profile 1 instead of the baseline story, targeted at the
   surfaces its demographics most affect (whole page populations — growth
   charts, AAP pediatric BP, elderly fitness norms, polypharmacy warnings —
   are invisible from the baseline's one vantage). Needs `UX_SEED=1`
   (the harness refuses other combinations); SEED_RNG dials do not apply.
   An unknown name FAILS the seed and the run — a persona label must never
   sit on data that isn't that persona. Registry + per-persona `routes` (the
   UX_ROUTES targets) live in the module; run one as e.g.:

   ```bash
   SEED_PERSONA=household UX_SEED=1 UX_ROUTES=/household,/upcoming,/timeline \
     node scripts/ux-walkthrough.mjs --serve pages
   ```

   | persona           | who                                                                    | most-affected targets                     |
   | ----------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
   | `bodybuilder`     | 28M, heavy 4-day split                                                 | /training /progress /nutrition /longevity |
   | `marathon-runner` | 34F, marathon block, Strava + Health Connect (one run from both)       | /training /equipment /integrations /data  |
   | `household`       | caregiver over 4 profiles: 40M rising LDL, 76F on 6 meds, sick twins   | /household / /upcoming /timeline /records |
   | `pregnant`        | 31F ~20wks: PHQ-9, ultrasounds, carrier variants; 15-year-old daughter | / /medical/cycles /upcoming /records      |
   | `diabetic-cgm`    | 52M dense glucose + docs; partner with chronic asthma + docs           | /medications /results /upcoming /data     |
   | `biohacker`       | 36M, 20 supplements, 3 practices, Oura + Withings                      | /nutrition /longevity /sleep /timeline    |

   Several personas are multi-profile households (profile 1 is the acting
   caregiver; members are created by the persona itself) and several carry
   `connected` integration rows with credential-less configs — the sync tick
   degrades gracefully while /integrations reads connected. Some exist partly
   to make a GAP visible (their registry entries carry `gaps`): pregnancy has
   no gestational-age model (#1402), CGM has no continuous-glucose stream
   (#2810), fasting has no surface yet (#2756) — expect those absences in the
   shots and report them as findings, not census failures. The pages census
   drives only profile 1; household members' own pages need an
   acting-profile switch the harness does not yet parameterize.
   Unit guards: `lib/__tests__/seed-personas.test.ts` (registry + route
   targets), `lib/__db_tests__/seed-personas.test.ts` (every persona against
   a live schema).

### Live screenshots outrank the census

The census's data is clean by construction, and a whole class of defect only
exists in a lived-in profile: cross-domain interference (a recent illness
putting Fever atop the Cycle page's symptom picker via frecency), import
quirks (a MyChart CCD repeating a diagnosis with " - Primary" baked into the
name), identity-family display leaks ("Family:vitamin-d-25-hydroxy" as a
label), and ordering regressions that need enough same-band rows to show. When
the owner posts a screenshot of their real app, treat it as a first-class
audit input — the 2026-08 sweep's highest-value bugs all came from two such
shots, none from the seeded census.

### Trace every symptom to its mechanism before filing

The first plausible mechanism is often wrong, in both directions:

- A jumbled dose order read as "bucket sort is alphabetical" — every #297
  layer was correct, and the real cause was the multi-profile merge comparator
  dropping ALL of `compareWithinBand`'s absolute tiebreaks (it sorted by raw
  key string). Filing the first hypothesis would have sent the fix to the
  wrong module.
- "Fever on the Cycle page" read as a category error — it is deliberate (the
  bar is the day's one symptom ledger; hiding a logged fever would lie), and
  the honest fix was a framing line, not a filter. Check whether the "bug" is
  a documented design before filing; the fix for those is copy.

Both directions end the same way: name the file:line mechanism in the issue,
or don't file yet.

## From findings to filings

The loop that survived owner contact, for anything bigger than a point bug:

1. Verify each visible defect in code (above), separating defects from design
   choices from owner calls.
2. Ship a **compact clickable prototype** of the redesigned surface — a
   single-theme artifact in the app's own dark look, with real `<details>`
   disclosures so fold behavior is demonstrable. Owner feedback was explicit:
   prototypes over design essays ("artifact is tldr"). Long-form rationale
   docs are for the record, not the pitch.
3. Before proposing a structural change (merging surfaces, retiring a tab),
   search closed/open issues for standing owner rulings — several surfaces
   are pinned by decision, not by code, and a proposal that re-litigates one
   burns the review.
4. File **self-contained issues**: artifact URLs are private-by-default, so
   the issue body must carry the full diagnosis and fix direction on its own.
   Bugs and redesigns file separately (bugs are shippable independently and
   often gate the redesign); resolved owner calls are recorded as resolved,
   open ones listed with a recommendation.

## Mobile audit (metrics + tap costs, #1510)

The harness also MEASURES — same seeing-tool ethos, numbers instead of
assertions. Two recorders, three artifacts next to the contact sheet:

- **`metrics.json`** (written by `pages`): per route × viewport — page height,
  first-data offset (first chart / table row / list item, px from top),
  table/form/overflow-menu counts, h1-scale headings (computed ≥ 20px), and a
  findings-flood heuristic (≥4 sibling cards sharing a 24-char text prefix).
  Plus the **geometry probes** (#3489): `clipped` — every element inside
  `<main>` whose RENDERED box exits the viewport horizontally with no designed
  scroller that reaches it — and `heightRows` — every rendered row whose
  interactive controls differ in height by more than 2px. Both carry the count
  they were truncated from, so a capped list is never silent.
- **`taps.json`** (written by `workflows`, `dose`, `dismiss`, `profiles`): tap
  costs per action. A tap = one pointer gesture; typing one field = one
  "input", counted separately. Reach costs (dashboard → each hub, driven
  through the real mobile drawer — never inferred from the nav model) come
  first; action spans are SURFACE-LOCAL (counted from the owning page), so a
  user's total cost = reach + action. Unmeasurable steps record a note, never
  a guess. Not every #1510-pinned action has a driving journey yet (household
  confirm, star) — gaps are visible in the table, add journeys to close them.
- **`audit.md`**: the ranked report — render faults and unreached dynamic routes
  first, then the two geometry tables, then worst first-data offsets, tallest
  pages, most standing forms, flood/multi-h1 detections, the tap table.

**Geometry (#3489)**: the geometry tables rank ABOVE the page-level ones because
they name a specific broken element instead of a page-level number, and they
cover BOTH viewports — a control can run off a 1280px desktop too. They exist
because a contact sheet cannot show a 4px height difference or a chevron one
pixel off-screen: the 2026-08-21 phone review found three such defects by eye
(#3478, #3481, #3486) that every prior census run had photographed and missed.
Read them as leads, not verdicts — a `clipped` span may be a truncation the
design intends. The rule is `scripts/ux-geometry-census.mjs`; that it can SEE a
planted offender and stays QUIET on a designed horizontal scroller and on a 1px
difference is asserted in `e2e/ux-geometry-probe.mobile.spec.ts`, which is the
only part of this that runs in CI — the census itself stays a seeing tool.

**Render health (#1544)**: the probe also records `renderFault` —
`not-found` when the page rendered `app/(app)/not-found.tsx`, `error-boundary`
when it rendered `app/(app)/error.tsx`. Both render INSIDE the app shell, so
their screenshots look like plausible pages and their metrics measure nothing
real. Read the render-fault table before trusting any ranking below it. Still a
measurement, not an assertion: page-level behavior belongs in `e2e/*.spec.ts`.

**Regression tracking**: `--baseline <prior shots dir>` diffs that run's
metrics/taps into audit.md. firstData/height growth **>15%** flags a route;
**ANY +1 tap** on an action flags it (tap regressions are step-function damage
— annotate the new baseline when a trade is deliberate, e.g. #1509, rather
than suppressing the flag).

The target vocabulary the audits established (use it when filing from a run):
first data inside one viewport-height; no standing rare-cadence entry forms
(#1497); nothing unrolls unbounded (#1496/#1504); one h1-scale heading per
page (#1449).

## Extending

A new dynamic route needs a `DYNAMIC_ROUTES` entry in
`scripts/ux-census-routes.mjs` — prefer `follow` (it stays correct as ids churn
and proves the index → detail link), and reach for `literal` only when the slug
comes from a static `lib/` enum. `lib/__tests__/ux-census-routes.test.ts` fails
until the entry exists.

Add a workflow by copying the shape in `workflowsJourney` (short, honest steps;
log loudly when a step can't complete — a blind spot must be visible). New
journeys register in the `journeys` map at the bottom of the script. Wrap a new
action's gestures in `beginTaps`/`tapClick`/`tapFill`/`endTaps` so it joins
`taps.json` — and close the span on every failure branch, or the count leaks
into the next action.
