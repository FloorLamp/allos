# Trash (recently deleted)

Status: shipped

Data → Trash (`/data?section=trash`, issue #2013) is the rendered view over the
restorable capture every destructive row delete has written into `deleted_rows`
since #30.

## What this is, and what it is not

It is **a read model plus a window plus two purges**. It is emphatically **not a
second restore engine.** All of the hard machinery already existed:

| Concern         | Owner                                                                                         | Note                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture         | `captureDelete` (`lib/undo-delete-db.ts`) over the pure kind registry in `lib/undo-delete.ts` | root row + cascade children + video clip rows, one transaction with the delete                                                                                                                                                                                       |
| Restore         | `restoreDeletedRow`                                                                           | new ids, external-FK reconciliation (#202/#375), merge inversion (#199/#200), re-import tombstone removal (#200)                                                                                                                                                     |
| Retention purge | `sweepDeletedRows`                                                                            | one call per hourly notify tick, global, unlinks orphaned clip files (#1290)                                                                                                                                                                                         |
| Auth            | `requireProfileWriteAccess(capture's profile)` + profile-scoped SQL                           | the restore gates the profile the CAPTURE carries (#2104), resolved from the holding row via `deletedRowProfile` — not the acting profile, which a multi-view delete need not match; the `profile_id` filter in `restoreDeletedRow` stays as the anti-replay compare |

The Trash adds: `lib/trash.ts` (pure derivation), `lib/queries/trash.ts` (the
list), `purgeDeletedRow` / `emptyTrash` (`lib/undo-delete-db.ts`), the section
under `app/(app)/data/`, and the admin retention setting.

**Restore goes through the existing core.** The Restore button calls
`undoDelete` — the same Server Action the 15-second toast calls — which calls
`restoreDeletedRow`. There is one restore path, and adding a surface did not
create a second one.

## The retention window

Instance policy, so **global settings, admin-gated** — the `audit_events`
precedent (#98) exactly:

- `DEFAULT_TRASH_RETENTION_DAYS = 30`, `MIN/MAX = 1 / 365`,
  `clampTrashRetentionDays()` in `lib/retention.ts`
- `getTrashRetentionDays()` / `setTrashRetentionDays()` in
  `lib/settings/server.ts` over the global `trash_retention_days` key — a
  settings key, no migration
- `TrashRetentionSettings` under Settings → Server → Advanced;
  `saveTrashRetention` gates on `requireAdmin()`. Navigation placement never
  replaces that gate.
- The hourly tick calls `sweepDeletedRows(getTrashRetentionDays())`

### The unit is days, everywhere

`sweepDeletedRows` used to take `maxAgeHours = 24`, which every call site read
as "one day" anyway. It now takes `maxAgeDays`, defaulting to the shipped
policy, and builds its cutoff through `daysAgoModifier`. There is exactly one
unit in the function and the parameter name says which; the DB-tier call sites
that passed `24` now pass `1`.

## The cost, stated plainly

`deleted_rows.payload` holds the deleted row's content, and captured video clips
stay on disk until purge. A 30-day default means **deleted health data and clips
persist 30× longer than they did under the old 24h window.** The PHI posture is
unchanged — the payload never leaves the same SQLite file, the same trust
boundary as the row it came from — but "I deleted this" meaning "gone within a
day" and meaning "gone within a month" are different promises.

Two things follow, and both are implemented:

1. The setting's help text says what the window actually holds — the deleted
   row's full content **and any video clips captured with it** — not merely "how
   long trash keeps things".
2. **Delete permanently** is what makes 30 days acceptable rather than merely
   longer, so it is one tap on the row, not buried behind Empty trash.

## The two purges

Both route through the **same file-unlinking path** the expiry sweep uses
(`capturedVideoFiles` → `unlinkPurgedVideoFiles`). A permanent delete that
removed only the `deleted_rows` row would leak the captured clips onto disk with
nothing left pointing at them — the #1290 leak, re-opened by hand.

- `purgeDeletedRow(profileId, undoId)` → `{ kind: "purged" | "gone" }`. "Gone"
  is a real state (another tab, the tick, an already-taken restore) and the row
  renders it rather than claiming a purge it did not perform.
- `emptyTrash(profileId)` → the number purged. **Profile-scoped, deliberately**,
  unlike `sweepDeletedRows`: the sweep is instance maintenance over an expired
  window; this is one person saying "clear mine", and emptying a household
  member's captures on your tap would be someone else's data disappearing.

The unlink runs **after** the transaction commits — the row delete is
authoritative, and best-effort filesystem work must never hold the write lock.

## Rendering

`deleted_rows.label` is a deliberately generic, non-PHI kind descriptor
("activity", "body metric") — enough to _count_ a trash, not to _choose_ from
one. The identifying content lives in `payload`, so `lib/trash.ts` reads a
title/date/note out of the captured ROOT row. That means the Trash renders PHI
and sits behind the same session gate as every other `(app)` surface, with free
text through `<NotesText>`.

- Payload parsing is **lenient**, not `parsePayload`: the bespoke
  `administration` capture (#851 item 11) is a real, restorable holding row
  whose payload is not a registry payload, and a Trash that threw on it would
  hide a row the user can still restore. Anything unreadable degrades to "no
  derived content", never to an exception.
- **Restore re-inserts with new ids.** Nothing here presents the captured row id
  as stable or links to a pre-restore route. The only id an entry carries is the
  holding row's — the undo token.

## What `deleted_rows` holds that the Trash does not list

The table has three writers; only two capture a deleted row.

`captureDelete` (the kind registry) and the `administration` ledger capture are
both restored by `restoreDeletedRow`, and both appear.

A **bulk correction** (#1603) snapshots the _inverse of an edit_ into the same
store to reuse its purge timer. It is not a deleted row, its undo is
`undoBulkCorrection` (a guarded per-row UPDATE that skips rows changed since and
reports how many), and it already has its own affordance on Data → Review.
Listing it under "Recently deleted" would misname it and offer a Restore button
that cannot work; Empty trash would silently destroy an undo still visible
elsewhere. So `TRASH_EXCLUDED_KIND` keeps it out of the list **and** out of both
by-hand purges — the expiry sweep still takes it, on its own schedule.

## Tests

- Pure — `lib/__tests__/retention.test.ts` (clamp floor/ceiling/garbage),
  `lib/__tests__/trash.test.ts` (headline derivation, expiry math, lenient
  payload handling, the excluded kind).
- DB — `lib/__db_tests__/trash.test.ts`: the sweep honours the configured window
  rather than a hardcoded day; permanent delete removes only that capture;
  Empty trash clears the acting profile's rows and leaves another profile's
  intact; restore-from-Trash is the same core as undo.
  `lib/__db_tests__/video-write.test.ts` covers the clip unlink on both the
  sweep and the by-hand purge.
- E2E — `e2e/trash.spec.ts`: delete a row, let the toast go, open
  `/data?section=trash`, restore it, assert it is back on its own surface.
