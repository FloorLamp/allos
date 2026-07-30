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
then trims to the last ~7 days — see the three shapes in §3):

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
   duplicates should correspond only to known redirect routes.
2. **Dispatch 3–4 parallel reviewer subagents**, each owning ~15–20 shots (split
   desktop alphabetically; one agent takes a mobile sample). Give each: the
   exact file list, the house conventions to judge against (one PageHeader h1 +
   subtitle, sentence case, frosted cards, `section-label` field groups, one
   date format per context, friendly empty states), and the three dimensions —
   hierarchy / text / layout.
3. **Tell reviewers which artifacts to EXCLUDE** or they'll report them as
   findings: the dev-overlay "1 Issue" badge (dev-only chrome) and any
   position:fixed bar smeared mid-image by fullPage capture (a fixed element
   renders once at an arbitrary scroll position — its mid-page "occlusion" is a
   screenshot artifact, though its presence may itself be a bug worth a
   separate look).
4. **Require refutability**: reviewers must name the route and the exact visible
   defect ("two identical ⋯ buttons at x1170/x1225"), list routes that look
   GOOD (proves coverage), and end with a top-5. Cross-check surprising claims
   against the code before filing (a "dead route" may be an intentional
   relevance redirect).
5. **Run all three census shapes** — they surface disjoint finding sets, and a
   whole class of degradation lives only in the middle one:

   | shape  | command                                                      | what it shows                |
   | ------ | ------------------------------------------------------------ | ---------------------------- |
   | fresh  | `node scripts/ux-walkthrough.mjs --serve pages`              | empty states                 |
   | thin   | `UX_SEED=thin node scripts/ux-walkthrough.mjs --serve pages` | a phone's first week         |
   | seeded | `UX_SEED=1 node scripts/ux-walkthrough.mjs --serve pages`    | ~3 weeks, full tables/charts |

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

## Mobile audit (metrics + tap costs, #1510)

The harness also MEASURES — same seeing-tool ethos, numbers instead of
assertions. Two recorders, three artifacts next to the contact sheet:

- **`metrics.json`** (written by `pages`): per route × viewport — page height,
  first-data offset (first chart / table row / list item, px from top),
  table/form/overflow-menu counts, h1-scale headings (computed ≥ 20px), and a
  findings-flood heuristic (≥4 sibling cards sharing a 24-char text prefix).
- **`taps.json`** (written by `workflows`, `dose`, `dismiss`, `profiles`): tap
  costs per action. A tap = one pointer gesture; typing one field = one
  "input", counted separately. Reach costs (dashboard → each hub, driven
  through the real mobile drawer — never inferred from the nav model) come
  first; action spans are SURFACE-LOCAL (counted from the owning page), so a
  user's total cost = reach + action. Unmeasurable steps record a note, never
  a guess. Not every #1510-pinned action has a driving journey yet (household
  confirm, star) — gaps are visible in the table, add journeys to close them.
- **`audit.md`**: the ranked report — render faults and unreached dynamic routes
  first, then worst first-data offsets, tallest pages, most standing forms,
  flood/multi-h1 detections, the tap table.

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
