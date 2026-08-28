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

| rule                                                                                      | source                  | guard                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Border/divider color language: alpha pairs for structural greys, literal fills for hovers | #794; `app/globals.css` | `border-alpha-language.test.ts`, `hover-fill-language.test.ts` |
| Card tiers `card` / `card-quiet`; responsive padding `p-4`→`sm:p-5`; `--card-gutter`      | #2701, #1416            | tier tests + census                                            |
| Radii: `--radius-card` 14px surfaces, `--radius-control` 0.5rem controls                  | #2701                   | `stat-tile.test.ts` (the stat tile's surface radius)           |
| Page width declared per page via `PageContainer`                                          | #794, #3253             | page-width scan test                                           |
| Custom named breakpoints use `rem`, so Tailwind can order them with its named breakpoints | #3477                   | `breakpoint-order.test.ts` (real PostCSS/Tailwind compile)     |
| Theme parity: tokens defined for both modes; body paints its ground                       | `lib/theme.ts`          | census both-theme captures                                     |

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

| container                     | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | status                                                                                                                                                                                                                           | guard                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Card / card-quiet             | the two surface tiers; nothing nests a card in a card; below `sm` neither draws a frame and each one's fill is full-bleed (#3673, #3920)                                                                                                                                                                                                                                                                                                                                                                                | shipped; both nests unwrapped (#3466)                                                                                                                                                                                            | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts`                                                             |
| Sub-panel (box inside a card) | one stepped inset convention, one notch down below `sm`: `subpanel-inset` (16→12), `subpanel-inset-sm` (12→10), `subpanel-inset-xs` (10→8). `DelegatedCard` lets its rendered parts carry the one gutter layer and takes no tier                                                                                                                                                                                                                                                                                        | shipped — #3466, #3507, #3726                                                                                                                                                                                                    | `mobile-density-convention.test.ts`, `delegated-card.test.tsx`, `delegated-card-css.test.ts`, routed phone geometry                    |
| Chip / pill                   | `components/Chip.tsx` owns navigation (`chip-nav`) and filter (`chip-filter`) presentation over its private `chip-base`. Its typed API admits regular/dense geometry and derives selected-state ARIA. `FilterPills` is the one single-choice filter-group composition: the whole group is links or buttons, carries its option metadata at the boundary, and chooses one bounded layout: scroll, wrap, or Timeline's phone-scroll/`sm`-wrap response. `SegmentedControl` remains the mutually-exclusive view primitive. | shipped — #3724 converged the ordinary single-choice groups and registered direct chip uses; heterogeneous equipment, multi-select toggles, typed fields, disclosures, and non-chip selected controls remain their own questions | `components/__tests__/chip.test.tsx`, raw-token residual `lib/__tests__/chip-residual.test.ts`, rendered geometry specs                |
| Stat tile                     | `StatBox` is the blessed tier and draws the `stat-tile` utility: tokened fill (`--ghost`, so dark mode comes with it instead of a hand-maintained `bg-slate-50 dark:bg-ink-900` pair) and `--radius-card`, because a tile holds content and is not a control — it had been wearing the CONTROL radius on a surface. Page-local variants fold in                                                                                                                                                                         | shipped — #3475; /medical/cycles' bordered page-local `Stat` folded into `StatBox`                                                                                                                                               | same suite                                                                                                                             |
| Card footnote                 | `card-footnote` pads to the card edge by design                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | shipped                                                                                                                                                                                                                          | —                                                                                                                                      |
| Section rhythm                | vertical section margins step down one notch below `sm` (40→24, 32→24, 24→16): `section-seam`, `section-seam-lg`, `section-stack`, `section-stack-sm`. Adjacent margins collapse to the LARGER, so a seam and the stack it lands beside must be stepped together                                                                                                                                                                                                                                                        | shipped — #3466                                                                                                                                                                                                                  | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts` + census height metrics                                     |
| Absence                       | an empty sub-section renders `EmptyState` `compact` — one line, one action; never the `p-10` billboard; an absence stops reserving room (#2399)                                                                                                                                                                                                                                                                                                                                                                         | shipped                                                                                                                                                                                                                          | review + census                                                                                                                        |
| Intro (lead + fold)           | one sentence, then a `<details>` the reader opts into: `LeadFold` (`lead` / `detail` / `summary`), never a hand-rolled disclosure and never a call-site type scale. Registry copy splits at the source (`IntegrationDef.lead` + `.detail`); the #1880 grid card renders the lead alone. `copy.md` §10 owns what goes in the lead (#3488, #3490)                                                                                                                                                                         | shipped                                                                                                                                                                                                                          | `lead-fold-census` (pure: the rule can see + a registry floor; e2e: rendered line boxes at 390px, nine intros, a planted 72-word wall) |
| Compact explanatory detail    | `InfoTooltipIcon` is the one compact touch, pointer, and keyboard disclosure for a full value or short explanation that cannot stay visible. The primitive owns its icon, tap target, placement, focus, Escape, and outside-dismiss behavior.                                                                                                                                                                                                                                                                           | shipped — registered by #3729                                                                                                                                                                                                    | routed 390px touch + keyboard disclosure coverage                                                                                      |
| Visualization details         | `VisualizationDetails` is the one disclosure for custom strips and diagrams that do not already have an equivalent touch scrub. Callers pass only a label and the same text values the visual encodes; the primitive owns disclosure geometry and presentation.                                                                                                                                                                                                                                                         | shipped — #3729                                                                                                                                                                                                                  | `components/__tests__/visualization-details.test.tsx`, routed 390px disclosure coverage                                                |
| Overlay destination           | `OverlayDestination` preserves a whole-row or whole-card primary destination while keeping compact disclosure buttons as DOM siblings, never buttons nested inside links. The primitive owns the overlay hit area and pointer delegation.                                                                                                                                                                                                                                                                               | shipped — #3729                                                                                                                                                                                                                  | `components/__tests__/overlay-destination.test.tsx`, routed 390px destination + disclosure coverage                                    |

#3729 classified the removed title census by what the hidden text meant: 55
allowance records represented 59 attributes — 14/15 full-value records/attributes,
22/25 status-detail records/attributes, and 19/19 visualization records/attributes.

### Picking a chip role (#3475)

A new strip picks a role by what it DOES, and inherits everything else. It never
picks colours, a padding, or a selected shade — those are not call-site
decisions any more.

| the strip…                                             | component contract       | selected state announced by     |
| ------------------------------------------------------ | ------------------------ | ------------------------------- |
| goes somewhere (a pane, a sub-page, an in-page anchor) | `Chip role="nav" href=…` | derived `aria-current`          |
| narrows what is already on screen                      | `Chip role="filter"`     | derived current/pressed ARIA    |
| opens or closes an editor                              | button-family disclosure | `aria-expanded`                 |
| labels something nobody can press                      | `badge`                  | — (not a chip)                  |
| switches a small mutually exclusive set of views       | `SegmentedControl`       | `aria-pressed` / `aria-current` |

Callers supply role, current/pressed state, optional density, content, and
behavior. They do not receive `className`, paint, shape, or selected-state ARIA
props. `FilterPills` is the one labelled single-choice group composition. It
requires the whole group to choose link mode or button mode, cannot mix both,
and owns density, option metadata, and three bounded layouts: scroll, wrap, or
Timeline's phone-scroll/`sm`-wrap response.
`undefined` means no selection; `null` is an honest selectable option (for
“All”), with React identity derived from value type plus value rather than a
caller-reserved string.

The residual guard rejects literal and hoisted `chip-base`, `chip-nav`,
`chip-filter`, and `chip-sm` tokens outside `components/Chip.tsx`. The unique
base token avoids confusing ordinary prose that says “chip” with presentation.
It has no adopter list or class-expression interpreter.

Timeline behavior is a closed `linkBehavior="timeline"` token. Callers cannot
inject a link component, classes, or selected-state ARIA; Chip derives the ARIA
and the registered adapter preserves PendingLink feedback, repeat-tap handling,
`scroll={false}`, and Timeline scroll restoration.

`CustomRangeDisclosure` and Food Log's “Earlier…” control only open option
editors. They use the button family with `aria-expanded`/`aria-controls`, carry
no selected-option ARIA, and are not deferred chip variants.

`SegmentedControl` keeps its inset track, but every option inside it owns a
rendered `min-h-11` target. The track's padding is not clickable and therefore
does not count toward the 44px floor; sibling option boxes must remain disjoint.
Its `fill` mode is opt-in: the primitive owns `flex w-full`, divides options with
`flex-1 min-w-0`, and lets the full visible label wrap; that same label is the
accessible name. Quick log uses that mode for its four equal phone
segments; the other thirteen consumers keep intrinsic `inline-flex` sizing (#3675).

Dense in-row strips request `density="dense"` from `Chip`; the component owns
their `text-xs` / `px-2.5` / `py-0.5` scale and rendered 44px target. Regular
chips omit the density prop. Timeline's category filters use the same typed
filter-link path while preserving their pending and scroll-restoration behavior.

### Below `sm`, no card draws a frame (#3673) and its fill is full-bleed (#3920)

The card **frame** is removed on a phone, not tightened. Below `sm` a `.card`, a
`.card-quiet` and a sub-panel tier give up their border, their radius and their
shadow; they keep their `--surface` fill and their vertical rhythm. Content sits
at the page gutter, and the page has **one left edge**.

**A band's FILL is full-bleed; its CONTENT keeps the page gutter.** #3673 took
the frame off and left the fill where it was — a filled surface inset by the page
gutter with no padding inside it — so a band's first character sat on its own fill
boundary. The fix is not a second inset: the band **cancels** the page gutter on
its frame and **re-spends** it on its content, so the fill runs 0→viewport width
while the text stays on the same 16px rag. The cancel mirrors the shell's own
expression per side — `--page-gutter-left` / `--page-gutter-right` in
`app/globals.css`, which `app-content-container` also reads — because the two
sides are independent and a symmetric `-mx-4` under-cancels a notched one.

- **Grouping is a label plus dividers.** The band shape: a `--surface` fill, a
  section label above it, `--divider` hairlines between rows —
  `DashboardStandingCluster`'s existing idiom, and the `band` utility is how a
  hand-rolled `rounded-* border bg-surface` frame says it is one.
- **Object-ness is the affordance.** A row with a control is a thing you act on;
  a row without one reports. The button was already saying what the border spent
  16px repeating.
- **The tinted Notice is the sole exception**, and it is owned by
  `components/Notice.tsx` — module identity, never a path or occurrence list.
  Notice and its FindingCard sibling are the only things that emit
  `data-notice`, and that attribute is what the phone sweep recognises. With
  every neutral frame gone the Notice is the loudest shape the app has, which is
  what a refused write or a safety flag needs; emphasis flattening is the
  failure this exception exists to prevent.

This **amends** #3466 for one class of card and leaves the rest in force. The
reasoning below was about TIGHTENING a gutter; this removes a layer. What
decided it was the left edge, not the pixels: a framed card's text starts at
32px and a band's at 16, so the left rag stepped 16px every time the page
alternated. The reclaimed line is the dividend — 358px instead of 326 on a 390px
viewport, 92% instead of 84%.

Desktop is untouched at every width ≥ `sm`: every declaration lives inside
`@media (width < 40rem)` or a `max-sm:` variant, so there is no per-site desktop
value to get wrong. The rule is written **unlayered** in `app/globals.css`,
because `@utility` bodies land in Tailwind's `utilities` layer and an unlayered
normal declaration beats every layer — a call site's own `p-6` cannot win the tie
back. The one thing it cannot beat is an `!important` declaration inside a layer
(for important declarations the layer order reverses and unlayered ranks last),
which is why the sub-panel tiers step `max-sm:py-*!` and their horizontal half is
zeroed by the flat rule instead.

| rule                                                                              | source | guard                                                                                                                             |
| --------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| No card frame below `sm` outside the Notice primitive; a band in a band is banned | #3673  | `mobile-density-sweep.mobile.spec.ts` (rendered sweep over ledger / Records / dashboard, a forged offender, the Notice's silence) |
| One left edge: every band, row and zone label starts at the page gutter           | #3673  | same file — the content edges on a dashboard scroll are the gutter and the full-bleed frame that delegates it, and nothing else   |
| A run on a band's fill has at least a page gutter of fill to its left             | #3920  | same file — plus the named surfaces, a one-sided safe-area inset, and no sideways scroll at 390px                                 |
| A band stays separable from the canvas in both themes                             | #3673  | `lib/__tests__/band-separation-tokens.test.ts` (recorded fill/divider floors) + a dark-mode e2e                                   |

### The two phone-density conventions, in one place (#3466)

Three spacing layers stack on a 390px line. The page gutter (16px) and the card
gutter (`p-4` below `sm`) were both at the platform floor and were **not**
tightened — a text line inside a card was ~83% of a 390px viewport. **#3673
removed the card's frame below `sm` and #3920 moved its fill to the viewport
edge**, so a card spends the page gutter and nothing else spends a second one:
the tiers below step the **vertical** inset only, and the horizontal one is zero. Their desktop values,
and the whole convention at `sm` and up, are unchanged. Pick a tier by what the
element carries **today**; add the class, change nothing else.

| carries today                         | add                 | phone                       |
| ------------------------------------- | ------------------- | --------------------------- |
| sub-panel `p-4` (16), or `p-4 sm:p-5` | `subpanel-inset`    | 12px vertical, 0 horizontal |
| sub-panel `p-3` (12)                  | `subpanel-inset-sm` | 10px vertical, 0 horizontal |
| sub-panel `p-2.5` (10)                | `subpanel-inset-xs` | 8px vertical, 0 horizontal  |
| seam `mb-6` (24)                      | `section-seam`      | 16px                        |
| seam `mb-8` (32)                      | `section-seam-lg`   | 24px                        |
| stack `space-y-10` (40)               | `section-stack`     | 24px                        |
| stack `space-y-6` (24)                | `section-stack-sm`  | 16px                        |

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
- **`DelegatedCard`** delegates its one gutter layer to its rendered parts.
  `Header` and standard `Cell` use the 16→20px gutter, compact `Cell` uses
  8→20px, and `Action` uses 8→12px. Its optional `Grid` owns the responsive
  columns and cell separators. The root and grid accept only their direct named
  parts, so a caller cannot insert a wrapper, pass a class/style/render slot, or
  choose padding classes. Component tests pin every part and semantic mode; a
  real Tailwind compile pins the three gutter values and the root's zero-padding
  premise. This replaces the former source/DOM topology interpreter, adopter
  registry, period-layout enumeration registry, and unrelated global `p-0!`
  allowlist (#3726).

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

| rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | source                                    | status / guard                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Button family: `btn` / `btn-ghost` / `btn-sm` / `btn-danger`; one disabled treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | #1450, #2701                              | shipped                                                                                                                                                                                                                                                                                                                                          |
| Ordinary secondary actions render through typed `Button`; an equivalent navigational door renders through `DestinationActionLink`, which composes `DestinationLink` rather than making Button polymorphic. Both expose the one fixed `button-control` treatment: 44px rendered below `sm`, compact content height above it, and no caller size/tone/class/style variants. Dashboard confirms/disclosures, Appointment Reopen, and Upcoming primary CTAs are the first routed adopters.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | #3714, #3720                              | `components/__tests__/button.test.tsx` + `e2e/button-primitive-adopters.mobile.spec.ts`                                                                                                                                                                                                                                                          |
| **One primary per surface.** A pane earns exactly one `btn`; alternatives are secondaries, overflow items, or row affordances. A pane is the ROUTE (page + the sections it mounts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `#3408`; formerly appearance.md           | `records-action-grammar.test.ts` (Records hub; extend with adoption)                                                                                                                                                                                                                                                                             |
| Overflow: everything rare (import, print, share, destructive row actions) goes behind `OverflowMenu`; below `md` it is an action sheet, decided in `AnchoredPanel`, never per consumer; a destructive verb is never a standing red button beside a record and always confirms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #3374, #3408                              | its component tests                                                                                                                                                                                                                                                                                                                              |
| Height floor: the whole `btn` family carries a below-`sm` min-height and min-width, declared ONCE in `app/globals.css` (SECTION: Touch tap targets), in `@layer components` so a call site that needs MORE still wins — a floor, not a ceiling; icon-only composition cannot shrink a button and no call site re-declares the floor. **44px RENDERED** under #3514's ruling (shipped at 40, moved with the ruling). What it does NOT reach is a hand-rolled control outside `.btn`/`.btn-ghost`/`.btn-danger`: the family is not the same set as "controls that need a floor" (#3486's third gap, found by #3529's probe on `StarButton`)                                                                                                                                                                                                                                                                                                       | shipped — #3486, value #3514              | `e2e/button-height-floor.mobile.spec.ts` — rendered bounding boxes, never a class string, and it refuses a call site re-declaring the floor at either number; the no-lowering direction is `e2e/mobile-ui-polish.spec.ts`'s pager measurement; the star/log pair on `/trends/metric/weight` is pinned EQUAL in `e2e/trends-metric-pages.spec.ts` |
| **Typed field height floor: every text/select field renders at least 44px on a phone.** The BOX is the target — a labeled row beside it may not stand in for it, and there is no per-site exception (owner ruling 2026-08-28, #3708). Declared ONCE on `.input` in `app/globals.css` (SECTION: Touch tap targets), in `@layer components` and below `sm` only, so it is a floor and not a ceiling (`min-h-16`/`min-h-20` textareas keep their height) and desktop density is untouched. `.input`'s natural 38px is under the floor, so this reaches the whole family, not only the 15 sites the #3502 reconciliation named; their `h-8`/`h-9`/`h-[38px]` stay for desktop because `min-block-size` outranks a `height`. No compact/size variant, no caller styling seam. What it does NOT reach is a typed field outside `.input` — `ActivityFormHeader`'s editable title is a heading that happens to be editable and carries the floor itself | owner ruling #3708; adopters #3706, #3709 | `e2e/tap-target-census.mobile.spec.ts` — routed rendered boxes at 390px (effective height, viewport containment, pairwise disjointness, focus, accessible name, editing behaviour) AND the converse at 640/1280px, because "nothing is under 44 at 390" also passes on a tree that is 44 at every width                                          |
| One control height per row (no `input` beside `btn-sm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | #3481                                     | #3481                                                                                                                                                                                                                                                                                                                                            |
| Links: `text-link` is the one inline action treatment; brand tone means interactive — static text never wears it, and no surface hand-rolls a link tone (sky included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | #2719; violations #3474, #3487, #3500     | lands with those fixes                                                                                                                                                                                                                                                                                                                           |
| **Selects are width-capped; no control renders past the viewport.** A control sized by USER-UNCONTROLLED DATA (item names, imported analyte names, a profile's name) has no width the page controls — release the flex content floor (`min-w-0`) and `truncate`, never a `max-w-*` alone, which cannot bite until the floor is released. The census can only see this class when the corpus carries a long name: `scripts/seed-long-names.ts` is the roster of families and the controls each one sizes, and adding a control of this shape means adding an entry there                                                                                                                                                                                                                                                                                                                                                                         | #3478                                     | clipped-content census probe (#3489) over the unbounded-name corpus (#3631, `SEED_RNG=3`); e2e/dose-ledger-phone.mobile.spec.ts                                                                                                                                                                                                                  |
| Tab strips scroll without painting scrollbars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #3488 ✓ shipped                           | `lead-fold-census.mobile` (computed cascade on the live strip vs an unsuppressed control — overlay scrollbars make the gutter unmeasurable here, measured)                                                                                                                                                                                       |

## 4. Affordance grammar

| rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | source / status                                                                          | guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page-level create = the page header's one primary; section-level create = that section's header-right action; form submits keep form grammar; nothing floats unhoused. `CreateAction` is the closed declaration for the eight current page/section semantics: its registry owns canonical trigger copy, any grammatically distinct dialog title, and housing; its client context supplies that copy directly to the registered trigger. It exposes no label, class, style, render, link, or visual-variant API; its sole optional state is `available`, which removes the host action container when false. `PageHeader.createAction` and `TabFirstPage.createAction` own page creates; `SectionCreateHeader` owns fixed title/subtitle/leading/action placement for protocol, routine, goal, equipment, and the supplement Manage section. The compact intake context keeps its specialized heading/date anatomy and accepts the same typed `createAction` declaration for its existing action cell. Unrelated controls remain secondary actions. Forms and `AddEntryPanel` keep their native form/disclosure semantics rather than becoming variants of the header primitive. | shipped — #3486, primitive #3731                                                         | Callers pass one typed `{ kind, control, available? }` declaration to a registered host. The host supplies page/section housing, `CreateAction` rejects wrong housing, and registered controls reject use outside `CreateAction`. Component tests render page, generic-section, and specialized-section hosts, prove unavailable declarations omit host chrome, render all eight controls with canonical accessible names, and preserve intake context anatomy. There is no repository source scanner or occurrence register. |
| One trigger verb: "Add X"; the "New X" minority converts. Dialog titles remain grammatical prose (for example, "Add a practice") and are registry-owned when they differ from the trigger label. `generateActivityTitle`'s "New activity" is a stored TITLE, not a label, and is out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | shipped — #3486                                                                          | Canonical page/section labels and distinct dialog titles live in `CREATE_ACTIONS`; form-submit and disclosure copy remains component-owned.                                                                                                                                                                                                                                                                                                                                                                                   |
| **Icon-only is a below-`sm` composition, not a rank.** A page or section primary MAY render icon-only below `sm` — the label span carries `hidden sm:inline` and the glyph stands alone — and from `sm` up it carries its label. It must then have an `aria-label`, because `display: none` removes that span from the accessible name and the phone is the one viewport where the control is bare. The `.btn` family's height floor is what makes this safe: before it, the same composition rendered 32px. This supersedes the earlier "never a page/section primary" wording, which three shipped primaries contradicted and which `button-height-floor` DEPENDED on contradicting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | shipped — #3486 (sites: /wellness `+`, supplement add toggle, metric measurement toggle) | `components/__tests__/create-action.test.tsx` pins canonical create identity/copy; `e2e/button-height-floor.mobile.spec.ts` proves the composition does not shrink and remains named.                                                                                                                                                                                                                                                                                                                                         |
| The dock FAB is the global quick-log — outside the create grammar, never unified away                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | recorded — #3486                                                                         | none, and none is needed: this row records a non-rule; the FAB is not a page/section create action.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Doors live on the surfaces they serve and name their destination; the owner-approved Household cabinet / illness pair shares that page header's action row. `DestinationIndicator` owns the one approved rightward glyph and its geometry. `DestinationLink` supplies its ordinary trailing placement; the named standing presentation and dense composed rows place the same indicator where their layout requires it. A rightward calendar, disclosure, carousel, or pager control is not a door and keeps its semantic control treatment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | shipped — #3253, #3479, #3487, #3502                                                     | `destination-link-primitive.test.ts` parses app/component TSX and rejects directly imported Tabler right-arrow/chevron/caret tags (including named import aliases) and literal text-arrow glyphs nested in a directly imported `next/link`. This small residual catches ordinary raw bypasses; the shared indicator is the enforcement. It has no per-file or per-occurrence registry.                                                                                                                                        |
| Action sheets name their row: `OverflowMenu` takes the row's `itemName` (+ optional `kind`) and COMPOSES the name in `lib/overflow-menu-label.ts`; no call site writes the sentence, and there is no `label` prop left to write it with                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | shipped — #3501, guard `lib/__tests__/overflow-menu-identity.test.ts`                    | `lib/__tests__/overflow-menu-identity.test.ts` (census floor before any verdict, throws on an `itemName` it cannot read)                                                                                                                                                                                                                                                                                                                                                                                                      |

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

| desktop anatomy                   | phone idiom                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | source                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data table                        | cards **below `sm` (640px)** via `ResponsiveTable` (never a bespoke clipping `<table>`); the boundary is `CARD_MODE_BREAKPOINT_PX` in `lib/card-row.ts` and is inherited, never restated; meta pairs atomic — wrap between pairs, never inside; a consumer takes the base treatment rather than restyling meta cells                                                                                                                                                                                                                                                                                                                                                             | #3457 ✓ shipped (boundary ruled `sm`), #3497, #3499 ✓ shipped — guards: `lib/__tests__/card-mode-boundary.test.ts` (the CSS and the constant hold one number) + `e2e/card-mode-boundary.spec.ts` (what actually renders either side of 640px, with a forged offender) + the rendered-geometry pair scan in `responsive-tables.mobile.spec.ts` / `trends-metric-pages.spec.ts` (`scanCardMetaPairs`)    |
| Checkbox matrix                   | per-kind stacked rows with labeled state chips; the chip states the waiting semantics AT the control (as a leading substring of the control's own accessible name, so the visible label is contained in it — WCAG 2.5.3), so the legend box shrinks to one line; the column sweeps become a framed, labeled panel above the list, because four bulk boxes that look exactly like routing chips are a destructive control with no visible disclosure; a kind with no master toggle reserves its slot below the boundary so every title starts at one x                                                                                                                            | ✓ shipped — #3495; the arrangement is `@utility notification-kind-matrix`, which joins the family `lib/__tests__/card-mode-boundary.test.ts` holds to `CARD_MODE_BREAKPOINT_PX` — guard: `e2e/notification-matrix-phone.mobile.spec.ts` (a `getBoundingClientRect()` probe with a forged 40px-column offender, plus a desktop case that fails if the card-mode-only alignment leaks past the boundary) |
| Corner toasts                     | one queued full-width snackbar above the dock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | #3373                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pagers                            | one idiom with thumb targets, from `lib/pagination.ts` + `PaginationControls`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | #3378                                                                                                                                                                                                                                                                                                                                                                                                  |
| Anchored ⋯ popover                | bottom action sheet, titled per #3501                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | #3374                                                                                                                                                                                                                                                                                                                                                                                                  |
| Text + trailing actions           | actions wrap under the text when width is short — identity is never what truncates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | #3491, #3473 — guard: `e2e/training-overview-actions.spec.ts` (the primary keeps its own line at phone width and the ghost pair shares the next; the rail arrives exactly at the `md` boundary and not before it; desktop is unchanged)                                                                                                                                                                |
| Standing rare-cadence entry forms | folded behind a disclosure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | #1497 (#3474 closes a violation)                                                                                                                                                                                                                                                                                                                                                                       |
| Hover-only information            | needs a touch path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | #3375                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tap floor                         | **44px EFFECTIVE target, everywhere** (owner ruling 2026-08-21, #3514) — met by rendered size (`min-h-11`) or a smaller rendered control extended to ≥44 effective by `.tap-target` (`inset: -6px` on a 32px icon ⇒ 44). Rendered height and hit area are different guarantees. **Partial, not globally converged:** `Button`, `IconButton`, `Chip` dense mode, the legacy button family, overflow actions, and the named rendered/overlay adopters own their floor. Unresolved dense controls, typed fields, raw hosts, and unreadable seams remain in the #3714 issue queue. `MedicationCard`'s `min-h-10` stays because the `<li>` is layout rhythm rather than a tap target. | `lib/tap-floor-tokens.ts` owns shared browser-proof geometry. Primitive component tests and rendered mobile geometry specs prove registered owners; #3706–#3709/#3719 track the remaining migrations. There is no global source-compliance claim.                                                                                                                                                      |

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

Phone-only shared utilities use the real Tailwind compile in
`lib/__tests__/phone-only-compiled-css.test.ts`. The test discovers every
`@utility` with a `max-sm` or exact phone-media contribution directly from
`app/globals.css`, compiles each discovered name in isolation, and inspects its
emitted PostCSS tree. Isolation prevents nested selectors from crediting one
utility with another utility's output. Every emitted declaration must have a
strictly-below-`sm` media ancestor. A colocated name-only contract set is checked
exactly against discovery so a missing or renamed utility fails; there are no
per-utility counts, properties, call-site registry, or source interpreter to
maintain (#3727). The proof remains a scope claim only: it does not prove that a
phone declaration composes safely with the cascade; #3510's `min-block-size`
replacement bug is deliberately outside this guard.

| tier                                  | covers                                                                                                                                                                                                 | status                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Language/lint scans (`lib/__tests__`) | border colors, hover fills, page width, records action grammar, copy lint, phone density (sub-panel insets + section rhythm, #3466)                                                                    | shipped — the proven pattern |
| Compiled phone-only CSS proof         | automatically discovered shared utilities contribute no declarations at `sm` or above in a real Tailwind compile (#3518/#3727)                                                                         | shipped — scope claim only   |
| Design-guard suite                    | chips, sheet titles, link tones — lands with each primitive per the guards ruling                                                                                                                      | pending, per-issue           |
| Census probes (#3489)                 | clipped content, control-height mismatch, ISO-date text scan (#3492), hover captures, cross-page consistency lane, named dirty profile, named one-completed-cycle middle state, post-merge mini-census | shipped                      |
| `components/**` test tier             | component-owned contracts, including `CreateAction` host/control boundaries                                                                                                                            | #3446, #3731 ✓ shipped       |

## Work map

Build order (the umbrella issue tracks it): this registry → #3446 ✓ shipped →
primitives (#3475, #3486 ✓ shipped except the floor's REACH, #3499 ✓ shipped, #3466 ✓ shipped, #3501, #3492 ✓ shipped, #3514 ✓ shipped) → idiom
adopters (#3495, #3460 ✓ shipped, #3491, #3473, plus standing #3374/#3378/#3408) →
copy cluster (#3488 ✓ shipped, #3490 ✓ shipped, #3480 ✓ shipped) → #3489's probes as the standing outer loop. Point bugs (#3459, #3478,
#3481, #3493, #3496, #3497, #3498, #3500) ship independently and adopt the
relevant primitive when they touch one.
