---
name: ux-walkthrough
description: Launch Allos against a scratch DB and drive the real UX journeys (fresh-install onboarding, email invite, all-pages census, common workflows) with a screenshot at every step. Use when asked to run the app, review UX end-to-end, or see what a flow actually looks like — not for assertions (those belong in e2e specs).
---

# UX walkthrough

Use [the harness](../../../scripts/ux-walkthrough.mjs) to capture real journeys
for visual review. Follow the [change and test policy](../../../docs/change-policy.md):
choose the smallest useful scope, verify findings before proposing changes, and
reuse existing coverage. A walkthrough does not establish that E2E assertions
passed. Keep findings concise; incident history belongs in git.

## Run against scratch data

Prefer letting the harness own the server and a unique private database:

```bash
UX_SHOTS=/tmp/allos-ux-onboarding \
  node scripts/ux-walkthrough.mjs --serve onboarding invite

UX_SEED=1 UX_ROUTES=/training UX_SHOTS=/tmp/allos-ux-training \
  node scripts/ux-walkthrough.mjs --serve pages workflows
```

`--serve` ignores a caller's `ALLOS_DB_PATH`, waits for readiness, and cleans up its
server and database. Captures remain for review. Use a new `UX_SHOTS` directory for
each run so old screenshots and sessions do not mix with current evidence.
`UX_ROUTES` filters `pages`; it does not scope the other journeys.

For an existing scratch server, omit `--serve`. Never use a production database.
Match `UX_ADMIN_USER`/`UX_ADMIN_PASS` to the server credentials. For a manual fresh
install, choose an unused database path and launch the server with:

```bash
ALLOS_DB_PATH=/tmp/allos-ux-manual.db \
ADMIN_USERNAME=admin ADMIN_PASSWORD=first-boot-pw-1 \
EMAIL_TEST_CAPTURE=/tmp/allos-ux-manual-mail.jsonl \
PORT=3111 npm run dev
```

Use the same capture-mail path in the harness. The invite journey configures fake
SMTP values and the public URL; [email capture](../../../lib/email.ts) writes local
JSON lines instead of sending mail. Wait for `/login` to return 200 before driving
a manually launched server. Run `onboarding` first for the fresh-install journey;
it saves the admin session later journeys reuse.

Other controls: `UX_BASE` (default `http://localhost:3111`), `UX_TIMEOUT_MS`, and
`UX_CHROMIUM` for an executable override. The browser resolver also checks
`PLAYWRIGHT_BROWSERS_PATH`. Screenshots default to gitignored `data/ux-shots/`.

## Choose journeys and data

Journeys are `onboarding`, `invite`, `pages`, `workflows` (search and quick logs),
`live` (workout), `dismiss`, `dose`, `profiles`, and `upload`. Select the journey
that reaches the affected state. A full census runs all five data shapes; a
focused audit names the shapes it covered and what remains unexamined.

| `UX_SEED`   | State exercised                                                           |
| ----------- | ------------------------------------------------------------------------- |
| unset       | Fresh install and empty states                                            |
| `thin`      | Roughly a week of dated observations; `UX_THIN_DAYS` adjusts trimming     |
| `1`         | Populated tables and charts                                               |
| `dirty`     | Fixed import residue and long names                                       |
| `one-cycle` | Two periods, one completed interval, below the cycle-statistics threshold |

Run each shape with `--serve pages` and a distinct output directory. Shape planning
lives in [ux-seed-shapes.mjs](../../../scripts/ux-seed-shapes.mjs); dial vectors live
in [seed-rng.ts](../../../scripts/seed-rng.ts).

- `SEED_RNG=<int>` gives `1` or `thin` a reproducible alternate scenario. Keep the
  same seed when comparing runs. `SEED_RNG=3 UX_SEED=1` exercises the
  [long-name corpus](../../../scripts/seed-long-names.ts) for geometry review.
- `dirty` and `one-cycle` select fixed vectors; do not combine them with
  `SEED_RNG`. Future boundary states belong in the existing named-shape model.
- `SEED_PERSONA=<name>` requires `UX_SEED=1` and excludes `SEED_RNG`. Read the
  [persona registry](../../../scripts/seed-personas.ts) for characters, target
  surfaces, and known gaps. An unknown persona fails the run. The pages census
  drives profile 1; other household members need an explicit profile switch.
- Seeded integration status does not prove a live provider connection. Owner
  screenshots are additional evidence of states the synthetic data may miss.

## Know what was captured

`pages` enumerates `app/(app)` routes at desktop 1280×900 and mobile 390×844.
[The route registry](../../../scripts/ux-census-routes.mjs) owns additional states:

- `DYNAMIC_ROUTES` resolves one instance per pattern through an index link or a
  static enum slug. Captures and metric keys use the pattern; `resolved` records
  the concrete URL. Unresolved patterns remain visible as blind spots.
- `HUB_VARIANTS` adds registered query-driven panels when their hub is selected.
  Other tabs and per-entity choices remain unexamined; name the actual panel in
  findings rather than treating its metrics as the whole hub.
- `DISCLOSURE_EXPANSIONS` adds a second expanded shot after default metrics. It
  also uncaps internal scrollers to expose content, so that shot cannot prove the
  normal layout's height or scrolling behavior. Nothing to expand is a blind spot.
- `HOVER_CAPTURES` adds desktop viewport captures; mobile does not claim hover
  coverage. Redirects record `landedOn` and appear in the alias table.

`UX_ROUTES` accepts comma-separated prefixes. A leading `=` makes an entry exact:
`UX_ROUTES==/` selects only the dashboard. Registries describe intended coverage;
the run's reached routes and blind spots establish actual coverage.

## Review the evidence

Start with the run log and `audit.md`: authentication failures, render faults, unreached routes,
and missing baseline surfaces precede interpretation. Inspect `FAILED` and blank
shots. Repeated identical images need an explanation such as a recorded alias;
they do not prove many pages rendered successfully.

| Artifact           | Use                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `index.html`       | Numbered screenshots in journey order; inspect candidates at full size                        |
| `consistency.html` | Comparable default desktop captures, excluding mobile, expanded, and hover states             |
| `metrics.json`     | Page metrics and rendered geometry, with examined counts and truncated-list totals            |
| `taps.json`        | Measured pointer gestures and typed fields; total cost is reach plus the surface-local action |
| `run.json`         | Seed shape, random seed, persona, and named vector used for comparison                        |

Review hierarchy, text, and layout against the
[design system](../../../docs/internals/design-system.md). Include density, inset
stacking, copy jargon, state honesty, and control grammar; the
[consistency artifact](../../../scripts/ux-consistency-review.mjs) supplies these
shared dimensions. If parallel review is authorized, split exact screenshot lists
by territory and assign a separate cross-page comparison. Report reviewed routes,
consistent examples, and at most five prioritized findings.

Treat geometry and tap tables as leads. Check clipped controls, mixed heights,
text collisions, and truncated person names against the rendered boxes and intended
scrollers. Missing measurements stay unknown. Distinguish dev-overlay and full-page
fixed-position capture artifacts from live defects; reproduce uncertain cases.

## Compare and report

`--baseline <prior shots dir>` flags page-height/first-data growth over 15% and any
added tap. A shape mismatch warns but still prints differences; an old baseline
without `run.json` cannot establish matching data. Compare matching states and
annotate deliberate tradeoffs instead of suppressing findings.

The committed [chrome baseline](../../../scripts/census-chrome-baseline.json)
measures shell geometry. Update it through `npm run gen:census-baseline`, review
the generated diff, and never hand-edit measurements. Unchanged shell geometry
says nothing about content changes; inspect the relevant default, expanded, hover,
or tab captures too.

Trace visible symptoms to their code owner and check standing owner decisions
before filing. Separate confirmed bugs from design choices and unresolved owner
calls. Follow [issue filing](../file-issue/SKILL.md) within the existing authorization;
include route, state, reproducible evidence, and mechanism. For a proposed
structural redesign, make a compact clickable prototype for owner review and keep
the diagnosis self-contained when artifact links are private.

## Scope a post-merge check or extend coverage

```bash
UX_SEED=1 node scripts/orchestration/post-merge-census.mjs HEAD^ HEAD --run
```

Without `--run`, the helper prints a plan. App territories map to route prefixes;
shared components and chrome require the full route set. Ambiguous changes require
a manual plan. This chooses coverage; it does not establish a completed review.

Extend the existing route/variant/disclosure/hover registries for a missing state.
Prefer following a real index link for dynamic routes; reserve literals for enum
slugs. Add a journey only when existing ones cannot reach the required workflow.
Use `beginTaps`/`tapClick`/`tapFill`/`endTaps` for new measured actions and close
spans on failure. Add tests only for a meaningful uncovered failure, never to pin
this guide's wording or mirror the registries.
