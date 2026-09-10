# Design system

This guide owns visual primitives, layout, and control selection. Reuse their
public APIs; styling variants belong to the primitive, not each caller.

| Subject                                  | Owning guide                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Domain architecture and storage          | [Architecture](design-doctrine.md)                                                   |
| Voice, display wording, lead/detail copy | [Copy](copy.md)                                                                      |
| Charts and accessible data drawing       | [Charts](charts.md), [day history](day-history.md)                                   |
| Animation                                | [Micro-motion](micro-motion.md)                                                      |
| Dialog hosts, gestures, dismissal        | [Overlays](overlays.md)                                                              |
| Lifecycle writes and one-tap feedback    | [Stateful affordances](stateful-affordances.md)                                      |
| Scope and test selection                 | [Change and test policy](../change-policy.md), [component tests](component-tests.md) |

Update the owning guide rather than copying it. Reuse existing tests; visual
changes do not automatically require new guards or assertions.

## 1. Tokens and themes

Botanical is the one visual language, with light, dark, or system mode.
`app/globals.css` owns semantic tokens; shared primitives consume them.

| Tokens                                                | Purpose                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `--canvas`, `--canvas-base`, `--nav`                  | Page and navigation grounds                           |
| `--surface`, `--border`, `--divider`, `--card-shadow` | Surfaces                                              |
| `--field`, `--field-bd`                               | Fields; boundaries retain ≥3:1 contrast in both modes |
| `--btn`, `--ghost` and foreground/hover pairs         | Actions                                               |
| `--seg-*`                                             | Segmented controls                                    |
| `--radius-card`, `--radius-control`                   | 14px surfaces, 0.5rem controls                        |

`lib/theme.ts` owns the `html.dark` decision and pre-paint script. Chart literals
live in `lib/chart-colors.ts` and `components/useChartColors.ts`; validate against
both card surfaces. The root error boundary and script-less offline shell keep
standalone Botanical literals deliberately.

Declare page width through `PageContainer` with a required named `width`;
`full` explicitly fills the shell. Its `className` accepts spacing and centering;
ESLint rejects literal `max-w-*` overrides. The route-width scan separately
checks centered caps and whether a page or ancestor layout declares a measure.
Custom named breakpoints use `rem`
so Tailwind orders them consistently. Media-query `rem` uses the browser's
initial font size; it responds to that preference, not authored root font size.

Verdict text uses emerald/amber; neutral context uses slate. `text-link` and
brand-toned text signal interaction; static copy does not wear link colors or
sky. Do not repeat a card's tone as an uppercase text verdict.

## 2. Container grammar

| Need                                   | Primitive                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Main or quiet surface                  | `card` / `card-quiet`; never nest cards or bands                                                                                     |
| Box inside a card                      | `subpanel-inset`, `subpanel-inset-sm`, `subpanel-inset-xs`                                                                           |
| Content split across card parts        | `DelegatedCard` and its named `Header`, `Cell`, `Action`, `Grid`; no arbitrary wrappers or styling slots                             |
| Stat                                   | `StatBox` / `stat-tile`, using `--ghost` and the surface radius                                                                      |
| Empty subsection                       | `EmptyState compact`; no large reserved billboard                                                                                    |
| Card-edge footnote                     | `card-footnote`                                                                                                                      |
| Intro disclosure                       | `LeadFold`; [copy](copy.md#lead-and-detail) owns content                                                                             |
| Short explanation or hidden full value | `InfoTooltipIcon`, with touch, keyboard, and pointer access                                                                          |
| Linked row with disclosure controls    | `OverlayDestination`; controls are DOM siblings, never buttons inside a link                                                         |
| Custom strip or diagram data access    | `SeriesSummary` / `SeriesPoint` in `components/SeriesAccess.tsx`; the same values are available as a hidden list and focusable marks |

Below `sm`, cards and sub-panels lose borders, radii, and shadows while keeping
fill and vertical rhythm. Filled bands cancel the shell gutter on their frame
and spend it inside; content keeps the page's left edge. Use separate
`--page-gutter-left/right` and `--page-bleed-*` values so safe-area sides remain
independent. A container placing cards in cells uses `bleed-none`, which clears
bleed without clearing content padding. Fill reaches the viewport or its placed
cell, never an intermediate inset.

Group bands with labels and dividers. `Notice` and its `FindingCard` sibling
retain their tinted emphasis through the owned `data-notice` treatment.

| Spacing utility                      | Below `sm`                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `subpanel-inset` / `-sm` / `-xs`     | 12 / 10 / 8px vertical; unfilled horizontal padding is zero, painted tiers spend the card gutter |
| `section-seam` / `section-seam-lg`   | 16 / 24px                                                                                        |
| `section-stack` / `section-stack-sm` | 24 / 16px                                                                                        |

Keep desktop values intact. Shared phone overrides and the unlayered flat-card
rule own the cascade. Adjacent margins collapse to the larger value, so inspect
the rendered gap when changing a seam. `DelegatedCard` parts own the one gutter
layer: Header/standard Cell 16→20px, compact Cell 8→20px, Action 8→12px.

## 3. Control grammar

Use typed `Button`: secondary by default, `primary` for a commit, `danger` for
destructive paint, one ghost-only `dashed` shape. No size or class axis.
`DestinationActionLink` composes navigation. Raw `btn` families retire with
their last caller.

One loud control per surface: a form's commit, a card's commit, a row's single
action. Destructive paint is loud; only rank classes fill, not wrappers. Peers
share no rank; a bulk action over rows is loud. A fold's door, app-shell chrome,
commits that can stand open together, read-narrowing submits, repeated-row
destructive actions, a warning's acknowledge-or-silence action, and the
`DoseConfirmButton` row affordance take no rank. Rare or destructive row actions
confirm through `OverflowMenu` ([Overlays](overlays.md)).

The shared `--control-box` is 34px at every viewport, padding from `1lh` and a
reserved border. It covers chips, the button family, typed fields, native
selects, and summaries marked `fold-control`. Row disclosures do not become
control-sized summaries. `IconButton`, `StarButton`, and dose-status circles
consume the box directly; segmented options, checkboxes, and Combobox option
rows keep their own 44px targets.

Typed fields retain ≥16px text to prevent focus zoom and derive padding from the
shared box. Do not add call-site height pins; taller textareas retain their
minimum height. Keep one control height per row.

On coarse pointers, supported controls extend reach 6px per side; adjacent hit
regions need at least twice that gap. The effective target floor is 44px.
Native inputs/selects cannot render the reach pseudo-element, so their box is
the target; migration to an owned picker is opportunistic. Geometry constants
live in `lib/tap-floor-tokens.ts`.

Controls sized by imported/user names need `min-w-0` and truncation within a
width cap. Preserve access to the full value. Exercise the long-name corpus in
`scripts/seed-long-names.ts` (`SEED_RNG=3`) when adding that shape.

`TabList` owns scrollbar suppression while preserving horizontal scrolling;
callers do not repeat its CSS.

`components/catalog.tsx` declares catalog adoption and equipment’s form, facts, usage
reader, and lifecycle. `CatalogRow`, `CatalogLifecycleControl`, and `CatalogEditor`
share row, action, and responsive form hosting. Pending kinds retain their domain
lifecycles.

### Chip roles

| Meaning                | Control                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Navigate               | `Chip role="nav"`; derives `aria-current`                                                                             |
| Filter current content | `Chip role="filter"`; derives current/pressed ARIA                                                                    |
| Offer a write          | `LabeledVerbChip` over the offer role: payload label plus verb nub, never selected; compact counterpart of `OfferRow` |
| Open an editor         | Button disclosure with `aria-expanded`/`aria-controls`                                                                |
| Noninteractive label   | `badge`                                                                                                               |
| Switch exclusive views | `SegmentedControl`                                                                                                    |

`Chip` owns its private presentation tokens and one geometry, with no density,
paint, class, or ARIA overrides. `FilterPills` composes single-choice groups:
choose links or buttons for the whole group and scroll, wrap, or Timeline's
phone-scroll/`sm`-wrap layout. `undefined` means no selection; `null` can be an
“All” option. Timeline's closed `linkBehavior="timeline"` preserves pending,
repeat-tap, and scroll-restoration behavior.

`SegmentedControl` options own their targets; track padding is not clickable.
Opt-in `fill` divides width equally and wraps visible labels, which also supply
the accessible names.

## 4. Affordance grammar

`CreateAction` owns canonical “Add X” trigger copy, distinct grammatical dialog
titles, and housing. Pass `{ kind, control, available? }` to `PageHeader` or
`TabFirstPage` for page creates, `SectionCreateHeader` for section creates, or the
specialized intake context's existing action cell. Unavailable declarations
remove host chrome. Forms and `AddEntryPanel` keep their own semantics; the dock
FAB remains the global quick-log.

A primary may hide its label below `sm` only with an accessible name and shared
target geometry.

Destination links name their destination and use `DestinationIndicator` through
`DestinationLink` or the registered composed presentation. Calendar, disclosure,
carousel, and pager arrows keep their own meanings. `OverflowMenu` receives
`itemName` and optional `kind`; `lib/overflow-menu-label.ts` composes its title.

`PageHeader.back` places `BackLink` above the title, visible even with
`compactBelowSm`. Pass the destination's title, without “Back to” or “All”;
the header owns spacing. Standalone links remain only on medication and
immunization print pages (beside Print), and episode detail (its title lives
in the summary card). Local-state back buttons keep their own behavior.

## 5. Phone idioms

`ResponsiveTable` switches from records to a table at
`CARD_MODE_BREAKPOINT_PX` in `lib/card-row.ts` (`sm`, 640px). Keep the intermediate
`sm` column tier before `md`; metadata wraps between label/value pairs, never
inside them. Use the shared card-row treatment.

Notification matrices become per-kind stacked rows with state named at each
control. Bulk column controls sit in a distinct labeled panel; missing master
toggles reserve their alignment slot. Other shared idioms:

- Toasts queue in one full-width snackbar above the dock.
- Pagers use `lib/pagination.ts` and `PaginationControls`.
- Trailing actions wrap below text before truncating identity.
- Rare-cadence standing forms sit behind disclosures.
- Hover information has a touch and keyboard path.

## 6. Verification

Reuse component, compiled-CSS, and geometry tests.
`phone-only-compiled-css.test.ts` checks utility breakpoints, not composition or
adoption. Density and residual scans are also bounded. Follow the shared
change/test policy; do not add adopter registries or mandatory test lists here.
