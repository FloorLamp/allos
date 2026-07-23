# The shared photo core (`lib/photo/*`, `components/photo/*`)

Status: shipped

The one capture → ingest → store → browse/compare stack every photo-carrying
domain uses (issue #1119, phase 1). The physique progress-photo domain
(`progress_photos`, phase 2) is its first tenant; skin (`lesion_photos`) and
symptom (`symptom_photos`) photos migrate onto it in phase 3, and video capture
(#1224) is expected to extend the same shell. This file is the contract a new
tenant builds against.

## Why one core (the chokepoint argument)

Three photo domains predate the core, each re-implementing a partial slice of
per-profile storage, sniffing, and serving — and none stripped metadata. The
privacy risk is at EGRESS: the full export bundles upload files verbatim and the
offsite backup mirrors raw bytes, so embedded GPS/device EXIF rides along —
metadata the user never entered and cannot see when consenting to a share or an
export. **Strip-at-ingest is the one chokepoint that keeps every current and
future egress path clean by construction** (the Telegram-chokepoint / import-
footprint philosophy). Per-egress-path scrub lists would drift; a single ingest
funnel cannot.

## The pipeline (server): `processPhoto(bytes)` — `lib/photo/ingest.ts`

Order is load-bearing:

1. **Gate** — empty / `MAX_PHOTO_BYTES` / magic-byte sniff (`sniffImageMime`,
   never the client-declared type). HEIC is rejected with a friendly error (the
   in-app camera path always produces JPEG; prebuilt sharp lacks libheif).
2. **Harvest before the strip** — `readJpegExif` (`lib/photo/exif.ts`, pure)
   pulls the ONE useful truth out of EXIF: the capture date
   (`DateTimeOriginal` → `DateTime`), so a photo taken last Tuesday and uploaded
   today defaults to Tuesday (`resolvePhotoDate`, `lib/photo/policy.ts` — an
   explicit user date wins; a FUTURE capture date is refused). **GPS is
   deliberately never decoded**: the parser only records that a GPS IFD exists;
   no field of its result can carry a coordinate.
3. **Auto-orient** — the EXIF orientation is baked into pixels (`sharp.rotate()`).
4. **Strip + downscale** — re-encode to JPEG (`quality 82`) inside a
   `PHOTO_MAX_EDGE` (2048px) box, `withoutEnlargement`. A sharp re-encode
   without `withMetadata()` carries no EXIF/GPS/XMP/ICC.
5. **Verify the strip** — `readJpegExif(output)` must report no Exif segment;
   otherwise the pipeline refuses to hand bytes back (defense in depth — we
   don't blindly trust the dependency either).
6. **Thumbnail + hash** — a `PHOTO_THUMB_EDGE` (320px) thumbnail for grids, and
   a sha256 `contentHash` of the PROCESSED bytes (identical captures dedup
   identically).

Returns a typed outcome: `{ kind: "processed", photo: ProcessedPhoto }` or
`{ kind: "invalid", error }` — callers never unconditionally confirm.
`ProcessedPhoto` = `{ bytes, thumbBytes, mime: "image/jpeg", width, height,
sizeBytes, contentHash, captureDate }`.

The client half (`components/photo/PhotoCapture.tsx` +
`lib/photo/client-compress.ts`) makes the common path clean/small at the first
hop — a canvas re-encode has no EXIF and `fitWithin` (the same pure sizing
computation the server tests pin) caps the upload at capture time — but the
server pipeline runs REGARDLESS. Never trust the client.

## Store / serve — `lib/photo/store.ts`

- `storeProcessedPhoto(domain, profileId, photo)` writes
  `data/uploads/<domain-dir>/<profileId>/<hash16>.jpg` + `<hash16>.thumb.jpg`
  and returns repo-relative paths for the row. Content-named ⇒ an identical
  re-store overwrites in place (idempotent).
- `unlinkPhotoFiles(domain, relPaths)` is best-effort and **path-contained**: a
  stored path resolving outside the domain root is skipped, never followed.
- Serve routes follow the lesion/symptom posture, hardened: session-gated,
  scoped `id AND profile_id`, path-contained, `nosniff`, `?thumb=1` for the
  grid asset, and the #478 JSON error shape
  (`app/api/progress-photo/[id]/route.ts` is the reference).

## Browse / compare — one model, two sibling views (#221)

`lib/photo/gallery-model.ts` (pure) owns: `selectableDomains` (only domains the
profile HAS photos in are offered — a gallery never renders an empty domain
tab), `filterBySeries` (pose / lesion / episode sub-filter), `dateGroups`
(most-recent-first grid), `timelineOrder` + `defaultComparePair` (oldest→newest,
first-vs-latest), `lightboxNeighbors` (no-wrap paging).

- `components/photo/PhotoGallery.tsx` — the browse index: domain selector
  (collapses when only one domain has photos; **domains are never co-mingled in
  one grid** — the privacy-tier separation is deliberate), series chips, a
  thumbnail grid (originals load only on lightbox open), and a lightbox with
  paging + domain-supplied actions (`renderActions`).
- `components/photo/PhotoTimeline.tsx` — the compare view over ONE series: two
  date pickers, side-by-side or an onion-skin overlay with a blend slider, and
  a thumbnail strip for the endpoints.

Captions/meta are factual only (date, weight snapshot) — no scoring, no
derived judgment anywhere in the core (product-decided, #1119).

## Adding a tenant domain (the phase-3 / #1224 checklist)

1. Add the domain key + dir to `PhotoDomain`/`DOMAIN_DIRS` in
   `lib/photo/store.ts`.
2. Domain write core (`lib/<domain>-photo-write.ts`, auth-blind, profileId-
   first): validate domain fields → per-profile `contentHash` dedup →
   `storeProcessedPhoto` → row insert, all inside `writeTx`; delete unlinks
   both files. `lib/progress-photo-write.ts` is the template.
3. Server Action: `requireWriteAccess` → parse → `processPhoto` →
   `resolvePhotoDate` → core → `revalidatePath`; an action-tier test proves the
   stored file is metadata-free (`spliceExifIntoJpeg` from
   `lib/photo/exif-fixture.ts` builds GPS-tagged synthetic fixtures).
4. Serve route scoped `id AND profile_id` with `?thumb=1`.
5. Row-ops side-state: `deleteProfile` gathers `stored_path`+`thumb_path` before
   the sweep and unlinks under the domain root; the export-completeness
   allowlist documents the export stance; owned-table registration.
6. Surface: `PhotoCapture` (pass the series' last photo as `ghostUrl`),
   `PhotoGallery` (add the domain — the selector lights up on data), and
   `PhotoTimeline` per series.

## Deliberately out (as of phase 2)

- **Phase 3** — migrating `lesion_photos`/`symptom_photos` writes onto
  `processPhoto`, their strips onto `PhotoTimeline`, their domains into
  `PhotoGallery`, plus the optional one-time EXIF-strip backfill of existing
  files.
- The **global quick-capture type→target chooser** (camera in the pinned
  quick-actions routing Progress/Skin/Symptom/Document) — meaningful once
  multiple domains ride the core; the in-context capture on `/progress` and the
  palette's `Add progress photo` action cover phase 2.
- **Offline capture queueing** — the client already downscales before upload so
  a queued blob would be small; wiring the capture flow into the offline write
  queue is future work.
- Lightbox pinch-zoom gestures.
