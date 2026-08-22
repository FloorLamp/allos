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
| Radii: `--radius-card` 14px surfaces, `--radius-control` 0.5rem controls                  | #2701                   | joins the container-grammar guard (#3475)                      |
| Page width declared per page via `PageContainer`                                          | #794, #3253             | page-width scan test                                           |
| Theme parity: tokens defined for both modes; body paints its ground                       | `lib/theme.ts`          | census both-theme captures                                     |

## 2. Container grammar

| container                     | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | status                                             | guard                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Card / card-quiet             | the two surface tiers; nothing nests a card in a card                                                                                                                                                                                                                                                                                                                                                                                                                               | shipped; both nests unwrapped (#3466)              | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts`                         |
| Sub-panel (box inside a card) | one stepped inset convention, one notch down below `sm`: `subpanel-inset` (16→12), `subpanel-inset-sm` (12→10), `subpanel-inset-xs` (10→8). A card that pads `p-0!` and lets its cells carry the gutter has ONE layer and takes no tier                                                                                                                                                                                                                                             | shipped — #3466                                    | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts`                         |
| Chip / pill                   | one primitive with the two **declared roles**: navigation (rounded-full outline pill, `data-chip-role="nav"`) and filter (`FilterPills` — soft tinted well, `rounded-md`, active FILLED, `data-chip-role="filter"`); `FilterPills` is the app's ONE filter affordance. The #3475 primitive extends this pair to selectable/status pills (range chips, section-status chips, toggle pairs) rather than inventing a third system; a hand-rolled chip row is the defect the rule names | partial (roles shipped, #3408) · **ruled** (#3475) | lint-style scan over hand-rolled pill groups                                                       |
| Stat tile                     | `StatBox` is the blessed tier, tokened fill, deliberate radius; page-local variants fold in                                                                                                                                                                                                                                                                                                                                                                                         | **ruled** — #3475                                  | same suite                                                                                         |
| Card footnote                 | `card-footnote` pads to the card edge by design                                                                                                                                                                                                                                                                                                                                                                                                                                     | shipped                                            | —                                                                                                  |
| Section rhythm                | vertical section margins step down one notch below `sm` (40→24, 32→24, 24→16): `section-seam`, `section-seam-lg`, `section-stack`, `section-stack-sm`. Adjacent margins collapse to the LARGER, so a seam and the stack it lands beside must be stepped together                                                                                                                                                                                                                    | shipped — #3466                                    | `mobile-density-convention.test.ts`, `mobile-density-sweep.mobile.spec.ts` + census height metrics |
| Absence                       | an empty sub-section renders `EmptyState` `compact` — one line, one action; never the `p-10` billboard; an absence stops reserving room (#2399)                                                                                                                                                                                                                                                                                                                                     | shipped                                            | review + census                                                                                    |

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
- **A card that pads `p-0!`** and delegates the gutter to its own cells has one
  layer, not two. Those cells _are_ the card token reproduced, so they take no
  tier — stepping them tightens the floor. The guard pins that exemption together
  with the `p-0!` premise that licenses it, so the exemption cannot outlive its
  reason.

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

| rule                                                                                                                                                                                                                                                                                                                                                      | source                                | status / guard                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button family: `btn` / `btn-ghost` / `btn-sm` / `btn-danger`; one disabled treatment                                                                                                                                                                                                                                                                      | #1450, #2701                          | shipped                                                                                                                                                                   |
| **One primary per surface.** A pane earns exactly one `btn`; alternatives are secondaries, overflow items, or row affordances. A pane is the ROUTE (page + the sections it mounts)                                                                                                                                                                        | `#3408`; formerly appearance.md       | `records-action-grammar.test.ts` (Records hub; extend with adoption)                                                                                                      |
| Overflow: everything rare (import, print, share, destructive row actions) goes behind `OverflowMenu`; below `md` it is an action sheet, decided in `AnchoredPanel`, never per consumer; a destructive verb is never a standing red button beside a record and always confirms                                                                             | #3374, #3408                          | its component tests                                                                                                                                                       |
| Height floor: the whole `btn` family carries a below-`sm` 40px min-height and min-width, declared ONCE in `app/globals.css` (SECTION: Touch tap targets), in `@layer components` so a call site that needs MORE (the pager's 44px step) still wins — a floor, not a ceiling; icon-only composition cannot shrink a button and no call site re-declares 40 | shipped — #3486                       | `e2e/button-height-floor.mobile.spec.ts` — rendered bounding boxes, never a class string; the no-lowering direction is `e2e/mobile-ui-polish.spec.ts`'s pager measurement |
| One control height per row (no `input` beside `btn-sm`)                                                                                                                                                                                                                                                                                                   | #3481                                 | #3481                                                                                                                                                                     |
| Links: `text-link` is the one inline action treatment; brand tone means interactive — static text never wears it, and no surface hand-rolls a link tone (sky included)                                                                                                                                                                                    | #2719; violations #3474, #3487, #3500 | lands with those fixes                                                                                                                                                    |
| Selects are width-capped; no control renders past the viewport                                                                                                                                                                                                                                                                                            | #3478                                 | clipped-content census probe (#3489)                                                                                                                                      |
| Tab strips scroll without painting scrollbars                                                                                                                                                                                                                                                                                                             | #3488                                 | its AC                                                                                                                                                                    |

## 4. Affordance grammar

| rule                                                                                                                                                                                                                                    | source / status                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Page-level create = the page header's one primary; section-level create = that section's header-right action; form submits keep form grammar; nothing floats unhoused                                                                   | **ruled** — #3486 (instances #3479, #3474, #3482, #3496, #3498)       |
| One verb: "Add X"; the "New X" minority converts                                                                                                                                                                                        | **ruled** — #3486                                                     |
| Icon-only `+` only in dense rows, always labeled for AT, never a page/section primary                                                                                                                                                   | **ruled** — #3486                                                     |
| The dock FAB is the global quick-log — outside the create grammar, never unified away                                                                                                                                                   | recorded — #3486                                                      |
| Doors live on the surfaces they serve, not stacked in page headers; door label = destination's own name; one arrow glyph (`›`)                                                                                                          | #3253, #3479, #3487                                                   |
| Action sheets name their row: `OverflowMenu` takes the row's `itemName` (+ optional `kind`) and COMPOSES the name in `lib/overflow-menu-label.ts`; no call site writes the sentence, and there is no `label` prop left to write it with | shipped — #3501, guard `lib/__tests__/overflow-menu-identity.test.ts` |

## 5. Phone idioms (below `md` / `sm`)

The standing transformations a desktop anatomy must undergo; a new surface
adopts the idiom rather than re-deriving a phone shape.

| desktop anatomy                   | phone idiom                                                                                                                                                                                  | source                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data table                        | cards via `ResponsiveTable` (never a bespoke clipping `<table>`); meta pairs atomic — wrap between pairs, never inside; a consumer takes the base treatment rather than restyling meta cells | #3457, #3497, #3499 ✓ shipped — guard: the rendered-geometry pair scan in `responsive-tables.mobile.spec.ts` / `trends-metric-pages.spec.ts` (`scanCardMetaPairs`) |
| Checkbox matrix                   | per-kind stacked rows with labeled state chips                                                                                                                                               | **ruled** — #3495                                                                                                                                                  |
| Corner toasts                     | one queued full-width snackbar above the dock                                                                                                                                                | #3373                                                                                                                                                              |
| Pagers                            | one idiom with thumb targets, from `lib/pagination.ts` + `PaginationControls`                                                                                                                | #3378                                                                                                                                                              |
| Anchored ⋯ popover                | bottom action sheet, titled per #3501                                                                                                                                                        | #3374                                                                                                                                                              |
| Text + trailing actions           | actions wrap under the text when width is short — identity is never what truncates                                                                                                           | #3491, #3473                                                                                                                                                       |
| Standing rare-cadence entry forms | folded behind a disclosure                                                                                                                                                                   | #1497 (#3474 closes a violation)                                                                                                                                   |
| Hover-only information            | needs a touch path                                                                                                                                                                           | #3375                                                                                                                                                              |
| Tap floor                         | 40px minimum targets                                                                                                                                                                         | #644, #3377                                                                                                                                                        |

## 6. Copy

`copy.md` is the owning doctrine (the eight rules + the copy-lint scan). The
2026-08-21 additions registered there: the machine-text display boundary
(prefs-formatted dates #3492 ✓ shipped, display-normalized units and labeled
enums #3493, safe list joins #3496, no title-casing clinical names), lead+fold
for intros and mechanisms (#3488, #3490, #3497), state honesty at low n (#3482,
#3498), and tone semantics for verdict vs neutral text (#3500). Guards: the
copy-lint scan plus the #3489 census text probes — the first of which, the
machine-date census, ships as `lib/machine-date-census.ts` (the rule),
`lib/__tests__/machine-date-census.test.ts` (it can see, and stays quiet) and
`e2e/machine-date-census.spec.ts` (the same rule over rendered text nodes).

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

| tier                                  | covers                                                                                                                                                                                       | status                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Language/lint scans (`lib/__tests__`) | border colors, hover fills, page width, records action grammar, copy lint, phone density (sub-panel insets + section rhythm, #3466)                                                          | shipped — the proven pattern |
| Design-guard suite                    | chips, add-affordance labels, sheet titles, link tones — lands with each primitive per the guards ruling                                                                                     | pending, per-issue           |
| Census probes (#3489)                 | clipped content, control-height mismatch, ISO-date text scan (#3492 ✓ shipped), hover captures, cross-page consistency lane, dirty-profile shape, middle-state dials, post-merge mini-census | **ruled**                    |
| `components/**` test tier             | enabling infrastructure for component-level guards                                                                                                                                           | #3446 ✓ shipped              |

## Work map

Build order (the umbrella issue tracks it): this registry → #3446 ✓ shipped →
primitives (#3475, #3486, #3499 ✓ shipped, #3466 ✓ shipped, #3501, #3492 ✓ shipped) → idiom
adopters (#3495, #3460 ✓ shipped, #3491, #3473, plus standing #3374/#3378/#3408) →
copy cluster (#3488, #3490, #3480) → #3489's probes as the standing outer loop. Point bugs (#3459, #3478,
#3481, #3493, #3496, #3497, #3498, #3500) ship independently and adopt the
relevant primitive when they touch one.
