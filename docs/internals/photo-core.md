# Shared photo core

Status: shipped

Photo tenants reuse the capture, processing, storage, and gallery owners below.
[Video](video-core.md) shares the profile-storage conventions and photo processing
for posters, but stores clip bytes without stripping their metadata.

## Owners and tenants

| Domain   | Row owner                        | Write core                                                |
| -------- | -------------------------------- | --------------------------------------------------------- |
| Progress | Profile and pose/date            | [progress-photo-write](../../lib/progress-photo-write.ts) |
| Lesion   | Skin lesion                      | [skin-photo-write](../../lib/skin-photo-write.ts)         |
| Symptom  | Symptom/date, with episode links | [symptom-photo-write](../../lib/symptom-photo-write.ts)   |
| Training | Activity or endurance-plan event | [training-photo-write](../../lib/training-photo-write.ts) |

Training photos have exactly one owner: `activity_id` or `endurance_plan_id`.
Their date comes from that owner rather than a separate photo-date column.
Deduplication is per profile within the domain, so attaching identical processed
bytes to another training owner can return the existing photo.

## Process before storing

[processPhoto](../../lib/photo/ingest.ts) returns a processed photo or a typed
invalid result. It performs these steps in order:

1. Reject empty, oversized, unsupported, or HEIC input. Sniff the bytes rather
   than trusting the declared MIME type. The shared cap is 15 MiB.
2. Read JPEG capture-date metadata before stripping it. The EXIF parser detects
   a GPS directory's presence but never decodes coordinates.
3. Bake orientation into pixels, resize inside a 2048px box without enlargement,
   and re-encode as JPEG at quality 82 without preserving metadata.
4. Reject output that still reports EXIF/GPS, generate a 320px thumbnail, and hash
   the processed image bytes with SHA-256.

[Photo policy](../../lib/photo/policy.ts) owns dimensions, quality, byte limits,
and date selection. For dated tenants, a valid explicit date wins; otherwise use
an extracted capture date no later than today, then today. Domain validation
still decides whether an explicit date is allowed.

[MediaInput](../../components/media/MediaInput.tsx) and
[client compression](../../lib/photo/client-compress.ts) reduce photo size and
metadata before upload. The server still processes every upload. The chooser is
the fallback for unavailable, denied, failed, or unobservable camera permission;
a phone permission prompt or known grant can lead with the viewfinder. Camera
capture produces JPEG. Document capture has a separate resolution/quality preset
in photo policy so text stays readable.

## Store and serve

[Photo storage](../../lib/photo/store.ts) maps the four domains to per-profile
folders under `data/uploads/`. It writes `<hash16>.jpg` and `<hash16>.thumb.jpg`,
returning repository-relative paths. Re-storing identical content uses the same
paths. Domain write cores own validation, deduplication, and row writes through
`writeTx`; the filesystem is not rolled back by a SQLite transaction.

Keep descriptive metadata edits separate from immutable stored content. A caption,
date, or series correction must not repoint a row's stored path or content hash.
Training permits caption edits while its parent supplies date and ownership.

`thumbSiblingPath` owns thumbnail naming. Lesion and symptom rows derive it
because they have no thumbnail column; their routes fall back to the full image
when the derived thumbnail is absent. Do not add a column just for that derivation.
`unlinkPhotoFiles` performs best-effort deletion contained within the domain root.

All photo serve routes require a session, contain paths within their domain root,
set `nosniff`, and support `?thumb=1`. Their authorization boundaries differ:

- Progress and lesion queries require the active profile's `profile_id`.
- Symptom and training routes resolve the row's owning profile and require
  `canAccessProfile`, matching household views without switching active profile.

An inaccessible row gets the same not-found response as a missing row. Preserve
the surface's profile boundary when reusing a route; file containment alone does
not authorize a read.

## Browse and compare

[Gallery model](../../lib/photo/gallery-model.ts) owns populated-domain selection,
series filtering, descending date groups, chronological comparison, first/latest
endpoints, and non-wrapping lightbox neighbors.
[PhotoGallery](../../components/photo/PhotoGallery.tsx) shows one domain at a time,
loads thumbnails for the grid, and accepts domain actions for the lightbox.
[PhotoTimeline](../../components/photo/PhotoTimeline.tsx) compares one series
side-by-side or with an overlay. Captions and context remain factual: no scoring
or derived judgments.

## Shared media export

Photo and video files are excluded from the default full export. The per-download
"Include photo & video files" option sets `?media=1`; it is not a saved preference.
[MEDIA_DOMAINS](../../lib/export-full.ts) owns the six included domains: progress,
lesion, symptom, and training photos, plus symptom and activity clips.

The bundle stores files under `media/<domain>/<rowId>-<storedName>` and row context
in `media/index.json`. The index is these tables' row export, so they do not also
belong in the ordinary dataset list. Thumbnails and posters are derived artifacts
and are not bundled. Photo bytes are the processed stored image; clip bytes retain
the uploaded container metadata. Files stream one entry at a time.

Each media query filters the exporting profile, and parent joins match that
profile too. Each file must resolve inside the domain's profile subdirectory;
missing or out-of-scope files are skipped. Media counts stay separate from medical
document counts. These authenticated media flows do not make media available in
public share links or the emergency card.

## Lifecycle and adding a tenant

Reuse the store and processing owner, then wire the domain's profile-first write
core to an authorized Server Action and [typed revalidation](server-action-refresh.md).
Reuse the capture/gallery surfaces and verify the write path with existing
synthetic EXIF fixtures where coverage needs extending.

Register profile-owned rows, export disposition, and file cleanup with the existing
owners. For activity children, declare merge behavior in `ACTIVITY_CHILD_LINKS` in
[merge-activity](../../lib/merge-activity.ts). Parent deletion, undo, merge, permanent
purge, and profile deletion must account for the files as well as their rows; use
the [trash contract](trash.md) for retained files and shared-path cleanup.

## Legacy metadata cleanup

[Metadata backfill](../../lib/photo/metadata-backfill.ts) covers stored lesion and
symptom photos. It is an asynchronous boot task with a versioned settings claim,
not a schema migration. `npm run photo:backfill` runs the pass manually.

The pass replaces bytes in place through the same processor, writes the thumbnail
before the full image, and updates MIME, size, and hash. When a processed hash
collides with another row, it keeps the historical hash. Already-clean JPEGs are
skipped without recompression. Missing or out-of-root files are skipped; unreadable
or unsupported images remain unchanged and count as failures. Inspect the tally:
a completed pass does not prove every legacy file was cleaned.

In-app offline photo queueing remains outside this core. A new capture entry point
should route into these owners rather than create another ingest pipeline.
