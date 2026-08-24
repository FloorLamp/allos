# Design system — the registry

Status: registry established 2026-08-21 (owner-directed, from the phone-review
consolidation). It absorbs and replaces `appearance.md`; individual rules carry
their own status below.

This file is the **index of the app's visual and interaction design rules**:
what the rule is, where its primitive lives, and which guard keeps it true.
Deep doctrine keeps its owning document — `copy.md` (voice), `charts.md`
(data drawing), `micro-motion.md`, `overlays.md`, `stateful-affordances.md`,
`day-history.md` — and this registry indexes them so there is one source per
rule. The architecture layer (substrates, identity, time model) is
`design-doctrine.md`, not this file.

## Doctrine

- **A rule is real when it has a primitive and a guard.** The 2026-08-21 review
  measured this directly: every convention backed by a shared primitive and a
  test (border colors, card tiers, the button family, the copy lint) produced
  zero findings, and every convention that lived only in prose drifted. A
  ruling without a guard is a suggestion.
- **Guards are mandatory** (owner ruling 2026-08-21, recorded on #3459–#3501):
  every design fix ships with a unit/db/e2e assertion, registry or lint-style
  test, or census probe that fails on regression. `components/**` has no cheap
  test tier yet (#3446); until it does, guards land in whatever tier can host
  them — never skipped.
- **One primitive per question.** A surface that needs a chip, a stat tile, a
  sub-panel, or an action sheet uses the shared one; hand-rolling a variant is
  the defect, not a style choice (CLAUDE.md's no-parallel-concepts rule applied
  to presentation).
- New rules are added here in the section they belong to, with their guard
  named. A rule proposed without a guard entry is not done.

Status legend: **shipped** (primitive + guard on main) · **ruled** (owner
decision recorded, implementation pending in the named issue) · **partial**.

## 1. Tokens, theming, and surfaces — shipped

One visual language: **Botanical**. Light, dark, or system mode; no selectable
palettes. `app/globals.css` owns the color ramps and semantic tokens; shared
primitives (`.card`, `.card-quiet`, `.input`, the button family, badges,
segmented controls) consume tokens rather than restating surface colors.

The structural tokens:

- `--canvas`, `--canvas-base`, `--nav` — page and navigation grounds
- `--surface`, `--border`, `--divider`, `--card-shadow` — cards
- `--field`, `--field-bd` — form controls (stronger than card borders, ≥3:1 in
  both modes, WCAG 1.4.11 — #2701)
- `--btn`, `--ghost` and their foreground/hover pairs — actions
- `--seg-*` — segmented controls

Dark mode is the `dark` class on `<html>`; `lib/theme.ts` owns the decision and
its pre-paint boot script. Chart marks need literal colors (CSS cannot reach
every SVG attribute): they live in `lib/chart-colors.ts` /
`components/useChartColors.ts`, validated against both real card surfaces —
see `charts.md`. The root error boundary and the script-less offline shell
restate Botanical literals on purpose, with focused tests against drift.

| rule                                                                                      | source                  | guard                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| Border/divider color language: alpha pairs for structural greys, literal fills for hovers | #794; `app/globals.css` | `border-alpha-language.test.ts`, `hover-fill-language.test.ts`   |
| Card tiers `card` / `card-quiet`; responsive padding `p-4`→`sm:p-5`; `--card-gutter`      | #2701, #1416            | tier tests + census                                              |
| Radii: `--radius-card` 14px surfaces, `--radius-control` 0.5rem controls                  | #2701                   | `chip-primitive-census.test.ts` (the stat tile's surface radius) |
| Page width declared per page via `PageContainer`                                          | #794, #3253             | page-width scan test                                             |
| Custom named breakpoints use `rem`, so Tailwind can order them with its named breakpoints | #3477                   | `breakpoint-order.test.ts` (real PostCSS/Tailwind compile)       |
| Theme parity: tokens defined for both modes; body paints its ground                       | `lib/theme.ts`          | census both-theme captures                                       |

The breakpoint guard deliberately stops at the token boundary. A source scanner
for “an arbitrary px variant and a named variant set the same property” would
have to reproduce Tailwind's candidate grammar, utility aliases, JSX class
composition, and generated CSS property expansion. A partial scanner would
either miss real collisions or report comments and harmless different-property
pairs. Keeping every custom named breakpoint in `rem` removes this repository's
known mixed-unit named-breakpoint hazard without claiming that incomplete
coverage.

At the browser-default 16px initial font size, `120rem` preserves the former
`1920px` 3xl boundary exactly. Media-query `rem` units use that browser initial
font size, not an authored or computed `html { font-size: ... }` value. A user
who chooses a different browser initial font size therefore intentionally shifts
the 3xl boundary (for example, 20px makes it 2400px); the former fixed-pixel
boundary did not respond to that preference.

## 2. Container grammar

| container                     | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | status                                                                                                                                                                         | guard                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Card / card-quiet             | the two surface tiers; nothing nests a card in a card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | shipped; both nests unwrapped (#3466)                                                                                                                                          | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts`                                                                                                                                                                                                                                                                                               |
| Sub-panel (box inside a card) | one stepped inset convention, one notch down below `sm`: `subpanel-inset` (16→12), `subpanel-inset-sm` (12→10), `subpanel-inset-xs` (10→8). A `card card-delegated` lets its rendered cells carry the one gutter layer and takes no tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | shipped — #3466, #3507                                                                                                                                                         | `mobile-density-convention.test.ts`, `card-delegated-gutter.test.ts`, `mobile-density-sweep.mobile.spec.ts`                                                                                                                                                                                                                                                              |
| Chip / pill                   | one primitive, `chip`, with two **declared roles** #3408 ruled: navigation (`chip-nav` — rounded-full outline pill; strips mark themselves `data-chip-role="nav"`) and filter (`chip-filter` — soft tinted well, `rounded-md`, active FILLED; `FilterPills` is the app's ONE filter affordance and strips mark themselves `data-chip-role="filter"`). The regular size is `px-3 py-1.5` over `text-sm`; dense in-row controls add `chip-sm`, the recorded `px-2.5 py-0.5 text-xs` horizontal/type consensus plus a rendered `min-h-11` target. The base reserves a transparent 1px border so both roles occupy one box at a given size. **The lit state is painted FROM THE ARIA** (`aria-current`, `aria-pressed`, or tab `aria-selected`), so a chip cannot look selected without announcing that it is. `chip-sm` renders the #3514 44px floor itself: pseudo-targets overlapped adjacent chips and could not enlarge native selects. A hand-rolled chip row is the defect the rule names | shipped — #3475 / #3525 (roles #3408); dense-strip and selected-state residue sweeps shipped with #2730. Timeline's category strip remains explicitly owned by its chrome lane | `lib/__tests__/chip-primitive-census.test.ts` (definition, adopters, named census + rendered floor, pattern-sees/pattern-quiet), `lib/__tests__/selected-state-primitive-census.test.ts` (primitive assignments, frozen keeps, planted hand-roll), plus `e2e/records-pane-anatomy.mobile.spec.ts` (rendered regular chips: one size, two shapes, paint follows the aria) |
| Stat tile                     | `StatBox` is the blessed tier and draws the `stat-tile` utility: tokened fill (`--ghost`, so dark mode comes with it instead of a hand-maintained `bg-slate-50 dark:bg-ink-900` pair) and `--radius-card`, because a tile holds content and is not a control — it had been wearing the CONTROL radius on a surface. Page-local variants fold in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | shipped — #3475; /medical/cycles' bordered page-local `Stat` folded into `StatBox`                                                                                             | same suite                                                                                                                                                                                                                                                                                                                                                               |
| Card footnote                 | `card-footnote` pads to the card edge by design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | shipped                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                        |
| Section rhythm                | vertical section margins step down one notch below `sm` (40→24, 32→24, 24→16): `section-seam`, `section-seam-lg`, `section-stack`, `section-stack-sm`. Adjacent margins collapse to the LARGER, so a seam and the stack it lands beside must be stepped together                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | shipped — #3466                                                                                                                                                                | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts` + census height metrics                                                                                                                                                                                                                                                                       |
| Absence                       | an empty sub-section renders `EmptyState` `compact` — one line, one action; never the `p-10` billboard; an absence stops reserving room (#2399)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | shipped                                                                                                                                                                        | review + census                                                                                                                                                                                                                                                                                                                                                          |
| Intro (lead + fold)           | one sentence, then a `<details>` the reader opts into: `LeadFold` (`lead` / `detail` / `summary`), never a hand-rolled disclosure and never a call-site type scale. Registry copy splits at the source (`IntegrationDef.lead` + `.detail`); the #1880 grid card renders the lead alone. `copy.md` §10 owns what goes in the lead (#3488, #3490)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | shipped                                                                                                                                                                        | `lead-fold-census` (pure: the rule can see + a registry floor; e2e: rendered line boxes at 390px, nine intros, a planted 72-word wall)                                                                                                                                                                                                                                   |

### Picking a chip role (#3475)

A new strip picks a role by what it DOES, and inherits everything else. It never
picks colours, a padding, or a selected shade — those are not call-site
decisions any more.

| the strip…                                             | class              | selected state announced by      |
| ------------------------------------------------------ | ------------------ | -------------------------------- |
| goes somewhere (a pane, a sub-page, an in-page anchor) | `chip chip-nav`    | `aria-current="page"` / `"true"` |
| narrows what is already on screen                      | `chip chip-filter` | `aria-current` or `aria-pressed` |
| labels something nobody can press                      | `badge`            | — (not a chip)                   |
| is a segmented control on the `--seg-*` pair           | `SegmentedControl` | its own component                |

So a call site is one static string plus the ARIA it already owed the reader.
Nothing else: `className="chip chip-nav"` and `aria-current={active ? "page" :
undefined}` is a complete chip. If a strip renders a group of options rather than
links, reach for `components/FilterPills.tsx` instead of the classes — it IS the
filter role, plus the scroll affordance and the labelled group.

Dense in-row strips add `chip-sm`; the modifier owns their `text-xs` /
`px-2.5` / `py-0.5` scale and rendered 44px target. The #3525 sweep
closed the audited non-Timeline strips; Timeline's category filter remains in
its separately owned chrome lane.

### The two phone-density conventions, in one place (#3466)

Three spacing layers stack on a 390px line. The page gutter (16px) and the card
gutter (`p-4` below `sm`) are at the platform floor and are **not** tightened —
a text line inside a card is already ~83% of a 390px viewport. What steps down is
the **second** gutter each spends inside itself, and the seams between sections.
Pick a tier by what the element carries **today**; add the class, change nothing
else.

| carries today                         | add                 | phone |
| ------------------------------------- | ------------------- | ----- |
| sub-panel `p-4` (16), or `p-4 sm:p-5` | `subpanel-inset`    | 12px  |
| sub-panel `p-3` (12)                  | `subpanel-inset-sm` | 10px  |
| sub-panel `p-2.5` (10)                | `subpanel-inset-xs` | 8px   |
| seam `mb-6` (24)                      | `section-seam`      | 16px  |
| seam `mb-8` (32)                      | `section-seam-lg`   | 24px  |
| stack `space-y-10` (40)               | `section-stack`     | 24px  |
| stack `space-y-6` (24)                | `section-stack-sm`  | 16px  |

Every tier is a `max-sm:` override carrying `!`, and both halves are
load-bearing. `max-sm:` compiles to a rule that emits **only** inside
`@media (width < 40rem)`, so no tier can reach a desktop viewport and there is no
per-site desktop value to get wrong. That is an **inference about what `max-sm:`
compiles to**, not a guarantee the tiers enforce on themselves: it was verified
by walking the compiled sheet (all seven rules inside that one media query, none
outside), and it would stop holding if `--breakpoint-sm` moved — nothing in the
test suite would notice. The `!` means the tier beats a call site's own `p-4`:
Tailwind 4 sorts custom utilities independently of source order, so without it
the convention would apply or not depending on generated order.

Two traps the guards exist for, both found by measurement rather than reading:

- **Adjacent margins collapse to the larger.** A stepped 16px seam beside an
  un-stepped 24px stack renders 24 — computed value correct, screen unchanged. A
  guard that reads the computed margin passes either way; the one here reads the
  **rendered gap** between the two elements the seam separates.
- **A `card card-delegated` card** delegates its one gutter layer to rendered
  carrier cells. `card-delegated` owns `overflow-hidden p-0!`; carriers use
  `card-gutter-standard` (16→20px), `card-gutter-compact` (8→20px), or
  `card-gutter-action` (8→12px), while their vertical padding remains local.
  These shared utilities preserve the deliberately different phone values
  without repeating horizontal numbers at call sites. The focused guard keeps a
  literal DOM-tag registry of all four parents and every carrier (including a
  local component's rendered root), bans named and arbitrary-property
  horizontal overrides at every breakpoint and logical edge, and rejects any
  unregistered adopter. Carriers must stay at card level: an unregistered DOM
  or component wrapper, or one registered carrier nested inside another, fails
  closed. The two PeriodStats layout wrappers are the only registered path;
  their grid and border helpers can return only exhaustively asserted,
  padding-free class registries. `ReadingsHeader` is the one component bridge,
  and its carrier must be the component's actual returned root. The guard also
  bans ad-hoc `p-0!` throughout `app/` and `components/`; the sole exact,
  fail-stale exception is ProtocolCompare's non-card icon button (#3507).

Scope, as **applied**: section rhythm was swept across every section-level seam
in the app shell. Out deliberately: `app/(auth)/*` and `/offline` (not app
routes), negative margins, and seams already breakpoint-scoped (`md:mb-6`,
`sm:mb-6`).

Scope, as **enforced** — and the two are not the same, which is the point of
saying so here. `lib/__tests__/mobile-density-convention.test.ts` guards the
conventions' DEFINITION: that each tier exists, is declared once, is spelled as a
`max-sm:` override carrying `!`, that no second convention is hand-written
anywhere in `app/`, `components/` or `lib/`, and that a NAMED census of sites and
exemptions still holds. It does **not** verify that every seam in the app has
adopted a tier. Measured on the sweep that shipped this: 77 tier applications
across 53 files, 27 of them in the 18 files the census names and 50 in files no
test names — and only 16 individually load-bearing, so most single applications
can be deleted with the suite green.

That gap is deliberate and it is the same trade this registry's doctrine names:
these are **a vocabulary, not an automatic rule**. A structural selector would
also catch badges, chips and fields, none of which are gutters; a tree-wide guard
would have to allow-list roughly a hundred boxes that #3466 cleared as list
rhythm or field chrome, and a guard carrying a hundred exceptions is deleted
within a week — taking the real convention with it. A new site or a new exemption
is recorded in that test; adoption elsewhere is a review question, not a gate.

## 3. Control grammar

| rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | source                                | status / guard                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Button family: `btn` / `btn-ghost` / `btn-sm` / `btn-danger`; one disabled treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | #1450, #2701                          | shipped                                                                                                                                                                                                                                                                                                                                          |
| **One primary per surface.** A pane earns exactly one `btn`; alternatives are secondaries, overflow items, or row affordances. A pane is the ROUTE (page + the sections it mounts)                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `#3408`; formerly appearance.md       | `records-action-grammar.test.ts` (Records hub; extend with adoption)                                                                                                                                                                                                                                                                             |
| Overflow: everything rare (import, print, share, destructive row actions) goes behind `OverflowMenu`; below `md` it is an action sheet, decided in `AnchoredPanel`, never per consumer; a destructive verb is never a standing red button beside a record and always confirms                                                                                                                                                                                                                                                                                                                                                             | #3374, #3408                          | its component tests                                                                                                                                                                                                                                                                                                                              |
| Height floor: the whole `btn` family carries a below-`sm` min-height and min-width, declared ONCE in `app/globals.css` (SECTION: Touch tap targets), in `@layer components` so a call site that needs MORE still wins — a floor, not a ceiling; icon-only composition cannot shrink a button and no call site re-declares the floor. **44px RENDERED** under #3514's ruling (shipped at 40, moved with the ruling). What it does NOT reach is a hand-rolled control outside `.btn`/`.btn-ghost`/`.btn-danger`: the family is not the same set as "controls that need a floor" (#3486's third gap, found by #3529's probe on `StarButton`) | shipped — #3486, value #3514          | `e2e/button-height-floor.mobile.spec.ts` — rendered bounding boxes, never a class string, and it refuses a call site re-declaring the floor at either number; the no-lowering direction is `e2e/mobile-ui-polish.spec.ts`'s pager measurement; the star/log pair on `/trends/metric/weight` is pinned EQUAL in `e2e/trends-metric-pages.spec.ts` |
| One control height per row (no `input` beside `btn-sm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #3481                                 | #3481                                                                                                                                                                                                                                                                                                                                            |
| Links: `text-link` is the one inline action treatment; brand tone means interactive — static text never wears it, and no surface hand-rolls a link tone (sky included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | #2719; violations #3474, #3487, #3500 | lands with those fixes                                                                                                                                                                                                                                                                                                                           |
| **Selects are width-capped; no control renders past the viewport.** A control sized by USER-UNCONTROLLED DATA (item names, imported analyte names, a profile's name) has no width the page controls — release the flex content floor (`min-w-0`) and `truncate`, never a `max-w-*` alone, which cannot bite until the floor is released. The census can only see this class when the corpus carries a long name: `scripts/seed-long-names.ts` is the roster of families and the controls each one sizes, and adding a control of this shape means adding an entry there                                                                   | #3478                                 | clipped-content census probe (#3489) over the unbounded-name corpus (#3631, `SEED_RNG=3`); e2e/dose-ledger-phone.mobile.spec.ts                                                                                                                                                                                                                  |
| Tab strips scroll without painting scrollbars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | #3488 ✓ shipped                       | `lead-fold-census.mobile` (computed cascade on the live strip vs an unsuppressed control — overlay scrollbars make the gutter unmeasurable here, measured)                                                                                                                                                                                       |

## 4. Affordance grammar

| rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | source / status                                                                          | guard                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page-level create = the page header's one primary; section-level create = that section's header-right action; form submits keep form grammar; nothing floats unhoused. Expressed as four HOUSINGS in `lib/add-affordance-grammar.ts` — an `action={…}` prop (the app's name for the header slot, on any header primitive), a section's own heading row, a `<form>` OR a field row (most creates post `FormData` by hand, so there is no `<form>` to find), and an `AddEntryPanel` disclosure. Asked of PRIMARIES only; a form's row repeater makes no placement claim                                                                                                                 | shipped — #3486 (instances #3479, #3474, #3482, #3496, #3498)                            | `lib/__tests__/add-affordance-grammar.test.ts` — census floor before any verdict, throws on a control it cannot read, proved on synthetic offenders and quiet on the benign neighbours                                                     |
| One verb: "Add X"; the "New X" minority converts, and so does the dialog heading the trigger opens. `generateActivityTitle`'s "New activity" is a stored TITLE, not a label, and is out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | shipped — #3486                                                                          | the same guard (verb rule over every affordance, not only primaries)                                                                                                                                                                       |
| **Icon-only is a below-`sm` composition, not a rank.** A page or section primary MAY render icon-only below `sm` — the label span carries `hidden sm:inline` and the glyph stands alone — and from `sm` up it carries its label. It must then have an `aria-label`, because `display: none` removes that span from the accessible name and the phone is the one viewport where the control is bare. The `.btn` family's height floor is what makes this safe: before it, the same composition rendered 32px. This supersedes the earlier "never a page/section primary" wording, which three shipped primaries contradicted and which `button-height-floor` DEPENDED on contradicting | shipped — #3486 (sites: /wellness `+`, supplement add toggle, metric measurement toggle) | `lib/__tests__/add-affordance-grammar.test.ts` (every icon-only create carries a name, over a census floor) + `e2e/button-height-floor.mobile.spec.ts` (the composition does not shrink, measured with the label asserted HIDDEN first)    |
| The dock FAB is the global quick-log — outside the create grammar, never unified away                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | recorded — #3486                                                                         | none, and none is needed: this row records a NON-rule (the FAB is outside the create grammar) so there is nothing for a guard to hold. `lib/__tests__/add-affordance-grammar.test.ts` never reaches it — the dock is not an add affordance |
| Doors live on the surfaces they serve, not stacked in page headers; door label = destination's own name; one arrow glyph (`›`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #3253, #3479, #3487                                                                      | open — the door rule has no scan; `lib/add-affordance-grammar.ts` deliberately excludes `<Link>` so the two rules cannot be confused, which is a boundary rather than coverage                                                             |
| Action sheets name their row: `OverflowMenu` takes the row's `itemName` (+ optional `kind`) and COMPOSES the name in `lib/overflow-menu-label.ts`; no call site writes the sentence, and there is no `label` prop left to write it with                                                                                                                                                                                                                                                                                                                                                                                                                                               | shipped — #3501, guard `lib/__tests__/overflow-menu-identity.test.ts`                    | `lib/__tests__/overflow-menu-identity.test.ts` (census floor before any verdict, throws on an `itemName` it cannot read)                                                                                                                   |

## 5. Phone idioms (below `sm`, except where a row says otherwise)

The standing transformations a desktop anatomy must undergo; a new surface
adopts the idiom rather than re-deriving a phone shape.

**Where card mode starts, stated once (#3457).** A `.table-cards` table is a
stack of records below `sm` (640px) and a table from 640px up — never below
`md` — and the number is declared once as `CARD_MODE_BREAKPOINT_PX` in
`lib/card-row.ts`, which every requirement, AC, component and spec quotes
instead of restating a breakpoint of its own.

The 640–768px band is a **designed middle tier, not a gap**: the record lists
ladder their columns in three steps — a base set at every width, a second from
`hidden sm:table-cell` (27 declarations across 12 files, re-derived 2026-08-22),
a third from `hidden md:table-cell` — and the `sm` tier exists only to give that
band a narrower table than the desktop one. Moving card mode to the `md`
breakpoint would make every one of those declarations inert, because
`.table-cards td[data-card=…]` (0,2,1) outranks the `.hidden` utility (0,1,0).
That is why #3457 resolved by correcting the requirements rather than the CSS,
and why a phone AC states its width (390px / 430px) rather than a breakpoint it
does not own.

| desktop anatomy                   | phone idiom                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | source                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data table                        | cards **below `sm` (640px)** via `ResponsiveTable` (never a bespoke clipping `<table>`); the boundary is `CARD_MODE_BREAKPOINT_PX` in `lib/card-row.ts` and is inherited, never restated; meta pairs atomic — wrap between pairs, never inside; a consumer takes the base treatment rather than restyling meta cells                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | #3457 ✓ shipped (boundary ruled `sm`), #3497, #3499 ✓ shipped — guards: `lib/__tests__/card-mode-boundary.test.ts` (the CSS and the constant hold one number) + `e2e/card-mode-boundary.spec.ts` (what actually renders either side of 640px, with a forged offender) + the rendered-geometry pair scan in `responsive-tables.mobile.spec.ts` / `trends-metric-pages.spec.ts` (`scanCardMetaPairs`)    |
| Checkbox matrix                   | per-kind stacked rows with labeled state chips; the chip states the waiting semantics AT the control (as a leading substring of the control's own accessible name, so the visible label is contained in it — WCAG 2.5.3), so the legend box shrinks to one line; the column sweeps become a framed, labeled panel above the list, because four bulk boxes that look exactly like routing chips are a destructive control with no visible disclosure; a kind with no master toggle reserves its slot below the boundary so every title starts at one x                                                                                                                                                                                                                                                 | ✓ shipped — #3495; the arrangement is `@utility notification-kind-matrix`, which joins the family `lib/__tests__/card-mode-boundary.test.ts` holds to `CARD_MODE_BREAKPOINT_PX` — guard: `e2e/notification-matrix-phone.mobile.spec.ts` (a `getBoundingClientRect()` probe with a forged 40px-column offender, plus a desktop case that fails if the card-mode-only alignment leaks past the boundary) |
| Corner toasts                     | one queued full-width snackbar above the dock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | #3373                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pagers                            | one idiom with thumb targets, from `lib/pagination.ts` + `PaginationControls`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | #3378                                                                                                                                                                                                                                                                                                                                                                                                  |
| Anchored ⋯ popover                | bottom action sheet, titled per #3501                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | #3374                                                                                                                                                                                                                                                                                                                                                                                                  |
| Text + trailing actions           | actions wrap under the text when width is short — identity is never what truncates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | #3491, #3473 — guard: `e2e/training-overview-actions.spec.ts` (the primary keeps its own line at phone width and the ghost pair shares the next; the rail arrives exactly at the `md` boundary and not before it; desktop is unchanged)                                                                                                                                                                |
| Standing rare-cadence entry forms | folded behind a disclosure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | #1497 (#3474 closes a violation)                                                                                                                                                                                                                                                                                                                                                                       |
| Hover-only information            | needs a touch path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | #3375                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tap floor                         | **44px EFFECTIVE target, everywhere** (owner ruling 2026-08-21, #3514) — met by either registered mechanism: rendered size (`min-h-11`) or a smaller rendered control extended to ≥44 effective by `.tap-target`'s hit-area overlay (#644: `inset: -6px` on a 32px icon ⇒ 44). Rendered height and hit area are DIFFERENT guarantees — a rule states which it means, never a bare "tap floor" number, and a control using NEITHER mechanism is the defect. **Converged**: the `.btn` family (rendered), `StarButton` and the two `IllnessNowGroup` controls (rendered), the `OverflowMenu` kebab and the responsive-table variant (`.tap-target` / `inset: -6px`), `MENU_ITEM`'s coarse-pointer row. `MedicationCard`'s `min-h-10` stays — an `<li>` row container is layout rhythm, not a tap target | #644, #3377, ruled + shipped #3514                                                                                                                                                                                                                                                                                                                                                                     | the ≥44 e2e measurements (`button-height-floor`, `mobile-ui-polish`, `dashboard-now`, `trends-metric-pages`). the census of hand-rolled controls outside the family is `lib/tap-floor-reach.ts` + `lib/__tests__/tap-floor-reach.test.ts` (#3557): 1456 controls, 159 of them pinning a height and therefore judged, the rest recorded rather than assumed. It also found that `.tap-target` adds a FIXED 12px, so the hit-area mechanism only reaches 44 from a 32px rendered box up — a control below that line wears the token and is still short. OPEN: #3489's control-height probe taking 44 as its threshold; #3561 (the census renders no verdict on a hoisted class list, which hides three 40px controls in `TrainingLogCalendar` sized against the old 40 floor); #3562 (three measured `.tap-target` controls at 34-36 effective, and 16 more nobody has measured) |

## 6. Copy

`copy.md` is the owning doctrine (the eight rules + the copy-lint scan). The
2026-08-21 additions registered there: the machine-text display boundary
(prefs-formatted dates #3492 ✓ shipped, display-normalized units #3493/#3545 and
labeled enums #3493, safe list joins #3496, no title-casing clinical names), lead+fold
for intros and mechanisms (#3488 ✓ shipped, #3490 ✓ shipped, #3497), state honesty at low n (#3482,
#3498), and tone semantics for verdict vs neutral text (#3500). Guards: the
copy-lint scan plus the #3489 census text probes — the first of which, the
machine-text census, ships as `lib/machine-date-census.ts` and
`lib/machine-lab-unit-census.ts` (the rules), their pure tests (they can see, and
stay quiet), and `e2e/machine-date-census.spec.ts` (the same rules over rendered
text nodes). The
second, the lead+fold census, follows the same three-file shape:
`lib/lead-fold-census.ts`, `lib/__tests__/lead-fold-census.test.ts` and
`e2e/lead-fold-census.mobile.spec.ts` (rendered line boxes at 390px).

## 7. Charts and data drawing

`charts.md` owns the doctrine. Headline registrations: one reading is a mark,
not a plot (`loneReading` + `SingleReadingMark`, #2615 — every chart family;
#3497/#3235 close the stragglers); the day-history substrate answers pattern
questions (`day-history.md`); the Standing sparkline column (#3252); chart
color validation as in §1.

## 8. Motion, overlays, stateful affordances

Owned by their documents, indexed here: `micro-motion.md` (the motion
vocabulary; witnessed-only dashboard motion per #3253), `overlays.md` (dialog
host convergence, escape/discard contracts), `stateful-affordances.md`
(pending links, one-tap feedback families).

## 9. Enforcement

Phone-only shared utilities use the compiled-sheet proof in
`scripts/phone-only-css-proof.mjs`. Add a utility to
`scripts/phone-only-css-registry.mjs` only when its contract is that every
declaration it contributes is below `sm`. To compare a focused branch with a
clean control worktree:

```bash
node scripts/phone-only-css-proof.mjs --control /path/to/origin-main-worktree
```

The compiler disables Tailwind's prose scanner. Each worktree gets its own
syntax-aware census of `className` values and the constants they reach across
`app/`, `components/`, and `lib/`, plus every static custom utility in the
sheet. Constant and helper reachability follows the TypeScript checker's actual
lexical and module symbols, including import aliases, defaults, and re-exports;
typed object and array members, local function-return members, and nested
destructured aliases trace back to their static value owner. Renamed component
props follow the component symbol to JSX callsites, and inline `map` bindings
follow their position in a finite static receiver. Computed keys pick
only their statically selected member; finite runtime key unions enumerate only
those members, while ambiguous or unbounded class-bearing owners fail closed.
Same-named or shadowed declarations are not merged. A changed callsite or desktop-only custom
utility therefore reaches its own artifact without treating visible copy as a
class candidate. Before
compilation the proof also derives every custom utility that uses `max-sm` or
one of the two exact phone media scopes; an unregistered candidate fails instead
of disappearing from both artifacts. It then removes those phone scopes
structurally at any nesting depth and compares the remaining semantic CSS tree
without collapsing declaration values or reordering cascade winners. Only
unique atomic `@property` registrations and their matching unique fallback
entries are order-normalized; duplicates fail closed. The proof fails on
compile/empty artifacts, missing expected declarations, a census below its
floor, or any remaining desktop-visible difference. Its claim is only that the
registered utilities contribute no declaration at `sm` or above. It does not
prove that a phone declaration composes safely with the cascade; #3510's
`min-block-size` replacement bug is deliberately outside this guard.

| tier                                  | covers                                                                                                                                                                                                 | status                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Language/lint scans (`lib/__tests__`) | border colors, hover fills, page width, records action grammar, copy lint, phone density (sub-panel insets + section rhythm, #3466), add-affordance grammar (verb + placement, #3486)                  | shipped — the proven pattern |
| Compiled phone-only CSS proof         | registered shared utilities contribute no declarations at `sm` or above; deterministic branch/control artifact comparison (#3518)                                                                      | shipped — scope claim only   |
| Design-guard suite                    | chips, sheet titles, link tones — lands with each primitive per the guards ruling                                                                                                                      | pending, per-issue           |
| Census probes (#3489)                 | clipped content, control-height mismatch, ISO-date text scan (#3492), hover captures, cross-page consistency lane, named dirty profile, named one-completed-cycle middle state, post-merge mini-census | shipped                      |
| `components/**` test tier             | enabling infrastructure for component-level guards                                                                                                                                                     | #3446 ✓ shipped              |

## Work map

Build order (the umbrella issue tracks it): this registry → #3446 ✓ shipped →
primitives (#3475, #3486 ✓ shipped except the floor's REACH, #3499 ✓ shipped, #3466 ✓ shipped, #3501, #3492 ✓ shipped, #3514 ✓ shipped) → idiom
adopters (#3495, #3460 ✓ shipped, #3491, #3473, plus standing #3374/#3378/#3408) →
copy cluster (#3488 ✓ shipped, #3490 ✓ shipped, #3480 ✓ shipped) → #3489's probes as the standing outer loop. Point bugs (#3459, #3478,
#3481, #3493, #3496, #3497, #3498, #3500) ship independently and adopt the
relevant primitive when they touch one.
