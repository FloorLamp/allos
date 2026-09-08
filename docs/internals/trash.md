# Trash (recently deleted)

Data → Trash (`/data?section=trash`) lists restorable deletes for one profile.
Its Restore button uses the same `undoDelete` action as the undo toast. See the
[undo contract](undo-contract.md) for client offers, timing, and refusal handling.

## Owners

| Concern                                                   | Owner                                              |
| --------------------------------------------------------- | -------------------------------------------------- |
| Capture kinds, children, foreign keys, and collision keys | `lib/undo-delete.ts`                               |
| Capture, restore, expiry sweep, and manual purge          | `lib/undo-delete-db.ts`                            |
| Display derivation and excluded kinds                     | `lib/trash.ts`                                     |
| Profile-scoped list and count                             | `lib/queries/trash.ts`                             |
| Restore authorization                                     | `app/(app)/undo-actions.ts`                        |
| Trash UI and purge actions                                | `app/(app)/data/TrashList.tsx`, `trash-actions.ts` |
| Retention limits and storage                              | `lib/retention.ts`, `lib/settings/server.ts`       |

## Capture and restore

`captureDelete` snapshots the root and declared children into `deleted_rows` in
one transaction with the delete. The holding row's id is the undo token.
`restoreDeletedRow` consumes that token atomically with restoring the capture.
An absent, already consumed, or wrong-profile token returns false.

Restore generally inserts new ids and remaps child foreign keys. It reconciles
external links whose targets disappeared, adopts live roots when declared keys
collide, reverses captured activity merges, and removes re-import tombstones.
Equipment restores its original id, preserving its load lane. Its captured set,
session, protocol, and goal rows survive deletion; restore reconnects only their
still-null equipment links, preserving later assignments and other edits. Deleted
linked rows are not recreated. The capture also retains the PR dismissals removed
by the delete; a newer dismissal with the same key wins on restore.
Registry counter entries restore the removed increment rather than overwrite a
whole day. The administration restore also reconciles its supply decrement.
Use these existing paths when adding a surface or kind.

Authorization follows the capture's owner: `undoDelete` resolves
`deletedRowProfile(undoId)`, calls `requireProfileWriteAccess(owner)`, then passes
that owner to the profile-scoped restore. The active profile can differ from the
capture's profile after a multi-profile delete. Keep both the authorization gate
and the SQL profile filter.

## Retention and permanent deletion

Retention is an instance setting, stored under `trash_retention_days`: default
30 days, clamped to 1–365 days. `saveTrashRetention` requires an administrator;
the control lives under Settings → Server → Advanced. The hourly notify tick
calls `sweepDeletedRows(getTrashRetentionDays())`; its argument is days.

Deleted content remains in the database and captured media remains on disk until
purged. Retention is a sweep threshold, not an exact deletion deadline: the list
can show a capture expiring today until maintenance removes it. The setting's
help text must explain what is retained.

| Operation                            | Scope and result                                           |
| ------------------------------------ | ---------------------------------------------------------- |
| `sweepDeletedRows(maxAgeDays)`       | Instance-wide expiry maintenance; returns rows removed     |
| `purgeDeletedRow(profileId, undoId)` | One eligible capture; returns `purged` or `gone`           |
| `emptyTrash(profileId)`              | That profile's eligible captures; returns the actual count |

The manual actions require write access to the active profile. A read-only user
may view Trash but cannot purge it. The UI reports `gone` when another restore,
purge, or sweep already consumed a token.

All three purges use `capturedFilesOf` → `unlinkPurgedFiles`. Media cleanup runs
after the holding-row deletion; manual purges commit their transaction before
unlinking. Filesystem cleanup is best effort and uses the domain's path-contained
unlink helpers.

- Video cleanup considers both the clip and poster, retaining paths still
  referenced by a live video row.
- Photo cleanup retains a live photo's files. Otherwise it removes the stored
  image and its thumbnail: use the captured thumbnail path when present, or
  derive it with `thumbSiblingPath`.
- Live-reference checks matter because a re-upload can reuse a content-named file.

## What belongs in Trash

Registry delete captures and bespoke `administration` captures appear in Trash.
`TRASH_EXCLUDED_KINDS` excludes bulk corrections and sleep re-times from the list,
count, and both manual purges. Those captures undo edits to rows that still exist;
emptying Trash must preserve their undo offers. The expiry sweep still removes
expired captures of these kinds.

The registry is the authoritative list of supported deletes. Keep these domain
boundaries when extending it:

- Clinical captures include allergy reactions and lesion photos. External
  document, visit, and provider links are reconciled on restore. Declared
  `external_id` keys allow adoption after reprocessing; snapshots preserve
  fields such as a condition's `edited` flag.
- Inbound links detached during deletion stay cleared on restore. Examples are
  a condition's intake links, a lesion's care-plan links, and a visit's inbound
  encounter links. Immunization dismissal cleanup is also not inverted.
- Medical-document deletion includes files, extracted rows, accounting, and
  deduplication across tables. It is not a registered undoable root; adding one
  registry entry would not capture that operation.
- `deleteReadingAt` captures whole-row deletes across its stores. Clearing one
  of several body measurements, or clearing mood energy/calm, leaves the row
  and produces no delete token. Deleting mood valence captures the whole
  check-in, including its note and factors.
- A `symptom-day` capture includes its photos and leaves their files for restore
  or purge. Symptom videos bind to the profile/day/symptom rather than the log
  id; deleting a symptom log does not delete or capture those clips. Deleting a
  custom symptom returns a batch of per-day tokens.
- Data → Manage uses `DATASET_UNDO_KIND` for bulk-delete capture. Read that
  mapping alongside the kind registry; not every undoable kind is a deletable
  dataset. Shared inbound detachment belongs in the capture path so bulk and
  individual deletes agree.

## Rendering

`deleted_rows.label` is a generic kind descriptor. Identifying titles, dates,
and notes come from the captured root's payload, so Trash renders health data
behind the authenticated, profile-scoped boundary. Render free text through
`NotesText`.

Display parsing is lenient: bespoke or unreadable payloads fall back to the
kind label without hiding the holding row. This does not relax restore parsing.
Entries carry the holding-row id, never a stable destination for the old root id.

Keep three time concepts separate:

- `TrashEntry.date` is the captured row's own storage day, selected through
  `DATE_COLUMNS`. Unsupported shapes become null; format this day before
  passing it to `trashEntryHeadline`.
- `deletedOnDay` comes from the deletion instant through `dateFromCreatedAt`
  using the profile timezone resolved by `listTrash`. Do not truncate UTC to
  obtain the displayed local day.
- Expiry uses the deletion instant plus the configured day duration, rounded up
  for the countdown. `TrashCapture.deletedAt` retains the raw instant.

## Existing verification

Start with `lib/__tests__/trash.test.ts` and `retention.test.ts` for display
fallbacks, dates, expiry, and the excluded-kind list.
`lib/__db_tests__/trash.test.ts` covers retention, restore, exclusions, and
profile-scoped purges;
`lib/__action_tests__/trash.actions.test.ts` exercises the write boundaries.

For capture or media changes, use the existing DB suites for `undo-delete`,
`clinical-undo`, `video-write`, `symptom-episode-photo-links`, `reading-writes`,
and `mood-log-store`.

`e2e/trash.spec.ts` covers restoring after the toast is gone, local deletion days,
and profile-isolated emptying. Its dedicated profiles own the bins they empty;
preserve that ownership when extending destructive browser cases.
