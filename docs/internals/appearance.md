# Appearance

Allos uses one visual language: Botanical. Users can choose light, dark, or
system mode; there are no separate selectable color palettes.

## Tokens and primitives

`app/globals.css` owns the Botanical color ramps and semantic surface tokens.
Shared primitives such as `.card`, `.card-quiet`, `.input`, the button family,
badges, and segmented controls consume semantic tokens instead of restating
surface colors. This keeps both modes coherent and makes contrast review
tractable.

The main structural tokens are:

- `--canvas`, `--canvas-base`, and `--nav` for page and navigation grounds
- `--surface`, `--border`, `--divider`, and `--card-shadow` for cards
- `--field` and `--field-bd` for form controls
- `--btn`, `--ghost`, and their foreground/hover pairs for actions
- `--seg-*` for segmented controls

Form boundaries use a stronger token than atmospheric card borders so controls
remain identifiable at 3:1 in light and dark. The dark mode is selected through
the `dark` class on `<html>`; `lib/theme.ts` owns that decision and its pre-paint
boot script.

## Action grammar: one primary per surface

A pane earns exactly one `btn` — its primary action. Everything else is a
secondary, an item behind a `⋯`, or a per-row affordance. The rule exists
because the Records hub grew ten button species without anyone deciding to
(#3408): a full `btn` per pane, a bordered secondary, two icon-only squares, a
standing ghost row action, a standing red destructive row action, nav chips,
filter chips, a private per-list chip, and a bare em-dash that read as a
control. Each one arrived reasonably; the tenth is what a reader has to parse.

The vocabulary, in the order to reach for it:

- **Primary — `btn`.** One per pane. The thing the pane is for: `Add visit`,
  `Add immunization`. If a second candidate appears, one of them is not primary.
  A pane is the ROUTE, not the file: `lib/__tests__/records-action-grammar.test.ts`
  counts a `page.tsx` together with the `*Section.tsx` bodies it mounts, because
  a pane that stacks four sections is still one surface to read. The one pane
  that genuinely stacks — `records/care/overview`, four collapsed `<details>` —
  is registered there with its reason rather than waved through by a finer unit.
- **Secondary — `btn-ghost`.** A named alternative that still belongs on the
  surface. Rare on a records pane, because records adds are rare-cadence by
  definition (#1497) and rarer actions belong in the fold below.
- **Overflow — `components/OverflowMenu.tsx`.** Everything rare: import, print,
  share, and every destructive row action. Below `md` this is an action sheet
  rather than a desktop context menu, and that decision lives in
  `components/overlay/AnchoredPanel.tsx` — no consumer chooses it (#3374).
- **Row affordance.** The `⋯` on the row itself. A destructive verb is never a
  permanently rendered red button beside a record; it folds, and it still
  confirms (#3408 item F).
- **Navigation chips vs filter chips.** Two shapes, on purpose, because they
  were one shape and a phone stacked three look-alike strips with three
  different meanings. Navigation is the family's rounded-full outline pill
  (`app/(app)/records/RecordsTabs.tsx`, `data-chip-role="nav"`); a filter is an
  inset control — soft tinted well, `rounded-md`, active state FILLED
  (`components/FilterPills.tsx`, `data-chip-role="filter"`). `FilterPills` is
  the app's ONE filter affordance; a list that hand-rolls its own chip row is
  the defect this rule names, not a local style choice.
- **Absence.** An empty sub-section renders `EmptyState` `compact` — one line
  and one action — never the `p-10` billboard. An absence stops reserving room
  (#2399), and a placeholder glyph in a flex row (no column to align) is
  deleted rather than styled.

`lib/__tests__/records-action-grammar.test.ts` holds the first half of this to
the Records hub by scanning for a second `btn` in a pane.

## Charts and exceptional surfaces

Chart marks and Recharts scaffolding need literal colors because CSS utilities
cannot reach every SVG attribute. Their values live in `lib/chart-colors.ts`
and `components/useChartColors.ts` and are validated against Botanical's real
light and dark card surfaces. See `docs/internals/charts.md` for the checks.

The root error boundary and script-less offline shell may render without the
normal stylesheet or theme class. They restate the same Botanical light/dark
colors as literals and have focused tests to prevent drift.
