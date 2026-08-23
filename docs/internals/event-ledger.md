# The event-ledger primitive

Status: **shipped** — one frame, mounted per domain (#3484 part 2). The dose
ledger's bespoke shell (`components/intake/DoseLedgerView.tsx`, 347 lines) is
gone; `/medications/dose-history` and `/nutrition/dose-history` are two mounts of
the frame and their routes and deep links are unchanged.

## The shape

A **row ledger** answers "fix a record": rows of logged events, newest first,
each editable and deletable, over a window the reader chooses. It is a different
question from the two the app already answers once each — the Timeline browses
("what happened?") and `lib/day-history.ts` renders the group×bucket matrix
("how consistently?"). **The day-history matrices are not ledgers** and stay
where they are.

Only doses had a ledger, and it was one file that knew everything. This splits
it in two along the line the ruling draws: **the frame is shared, the contracts
are not.**

## What the frame owns

`components/ledger/EventLedgerFrame.tsx` — a server component — places:

- the back link and the page heading,
- `DateRangeControl`,
- the chip axis (`FilterPills`, link mode),
- the item filter (`components/ledger/EventLedgerItemFilter.tsx`),
- the **backfill slot** — the box, not its contents,
- the window note and the empty state, **in #3478's order**: empty, the state
  leads and the slot follows it; populated, the slot keeps its place above rows
  that are actually there,
- `PaginationControls`, over a read the mount paged.

One `idPrefix` names every part (`dose-ledger` → `dose-ledger-page`,
`dose-ledger-empty`, `dose-ledger-pagination`, …). A mount does not get to name
the frame's internals: two ledgers whose pagers answered to different ids would
be two frames again as far as any spec or census is concerned.

## What a mount owns

Everything a domain decides. `components/intake/DoseLedgerMount.tsx` is the
worked example:

- the **read** and its bound — `getIntakeDoseLedgerPage`, paged at the SQL level
  (#2445), profile-scoped at the page boundary as before;
- the **vocabularies** — which chips, which items, how a retired item is
  labelled;
- the **sentences** — the window note and the empty state come in finished, from
  `lib/dose-ledger.ts`, where they stay unit-testable;
- the **rows** (`DoseLedgerRows.tsx`) — columns, link targets, the amend contract
  (#2228: the edit form seeds its time from `statedAt` and nothing else), and the
  domain's undo contract (`deleteAdministration` returns an `undoId`, carried by
  `EntryHistoryTable`'s shared undoable-delete path);
- the **backfill slot's contents** (`DoseBackfillLauncher.tsx`) — which items can
  be logged against, the plausibility gates, the write;
- the **hrefs** — every axis drops the page, because a narrowed ledger re-pages
  from its first row.

#2417's one-ledger-two-doors survives as one mount opened at two pre-filters:
the two routes differ in exactly one thing, the kind they open filtered to.

## Instants and days

The primitive **inherits** the time model as it stands and re-derives nothing.
#3428's day-bucketing question is open and applies to the primitive exactly as it
applied to what it replaces; a mount that wanted a different answer would be
answering #3428 in one surface.

## The seam, as a measurement

`lib/__tests__/event-ledger-seam.test.ts` scans both sides:

- the shell may not **know** a domain — an allowlist of the modules it may
  import, and a vocabulary scan over its code with comments stripped;
- a mount may not **rebuild** the frame — the mount list is explicit, no mount
  imports a frame part directly, and the frame stays the app's only file that
  imports both `DateRangeControl` and `PaginationControls`.

Every recognizer is exercised against source written to break it, in the same
file.

`components/__tests__/event-ledger-frame.test.tsx` pins the body order in the
component tier, so #3478's fix fails in two seconds rather than in a phone-width
Playwright run.

## Adding a mount

1. Read and page in the mount; keep the reader profile-scoped at the boundary.
2. Compose the window and empty sentences in `lib/`, so they are unit-testable
   and not trapped in a component.
3. Render `EventLedgerFrame` with your rows as children and your write
   affordance as `backfill`.
4. Add the file to the mount list in the seam test.

If a rule of yours seems to want to live in the frame, the seam is in the wrong
place: put it in the mount.
