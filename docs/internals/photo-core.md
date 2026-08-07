# The shared photo core (`lib/photo/*`, `components/photo/*`)

Status: shipped

The one capture → ingest → store → browse/compare stack every photo-carrying
domain uses (issue #1119, phase 1). The physique progress-photo domain
(`progress_photos`, phase 2) was its first tenant; skin (`lesion_photos`) and
symptom (`symptom_photos`) photos joined it in phase 3 (#1844), so **all three
photo domains now ride one ingest**. **Video capture (#1224) shipped as a
SIBLING core** — `lib/video/*` / `components/video/*`, same
per-profile store conventions and strictest-privacy tier, adding container
sniffing, a Range-capable serve, and poster frames; see
`docs/internals/video-core.md` (the poster frame it extracts is EXIF-stripped
through THIS core's `processPhoto`). This file is the contract a new photo
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
   pulls the ONE useful truth out of EXIF: the capture date (`DateTimeOriginal`
   → `DateTime`), so a photo taken last Tuesday and uploaded today defaults to
   Tuesday (`resolvePhotoDate`, `lib/photo/policy.ts` — an explicit user date
   wins; a FUTURE capture date is refused). **GPS is deliberately never
   decoded**: the parser only records that a GPS IFD exists; no field of its
   result can carry a coordinate.
3. **Auto-orient** — the EXIF orientation is baked into pixels
   (`sharp.rotate()`).
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
`ProcessedPhoto` =
`{ bytes, thumbBytes, mime: "image/jpeg", width, height, sizeBytes, contentHash, captureDate }`.

The client half (`components/photo/PhotoCapture.tsx` +
`lib/photo/client-compress.ts`) makes the common path clean/small at the first
hop — a canvas re-encode has no EXIF and `fitWithin` (the same pure sizing
computation the server tests pin) caps the upload at capture time — but the
server pipeline runs REGARDLESS. Never trust the client.

The native fallback preserves transient user activation (#2182): a real tap goes
straight to the hidden camera input when `getUserMedia` is absent or a denied /
failed outcome is already cached. Only an unknowable first async failure opens
the fallback dialog; that dialog uses a styled **Open camera** button, diagnoses
blocked / missing / busy cameras, and gives best-effort permission recovery text.
`autoOpen` deep links always use the dialog because a mount effect has no user
activation. A recovered live camera restores the onion-skin path, while every
picked file still runs the same client and server strip/downscale pipeline.

## Store / serve — `lib/photo/store.ts`

- `PhotoDomain` is `progress` / `lesion` / `symptom`; `DOMAIN_DIRS` maps each to
  the per-profile dir it already used, so phase 3 moved no files.
- `storeProcessedPhoto(domain, profileId, photo)` writes
  `data/uploads/<domain-dir>/<profileId>/<hash16>.jpg` + `<hash16>.thumb.jpg`
  and returns repo-relative paths for the row. Content-named ⇒ an identical
  re-store overwrites in place (idempotent).
- `thumbSiblingPath(storedPath)` is the ONE rule naming a photo's thumbnail:
  drop the extension, add `.thumb.jpg`. `progress_photos` records `thumb_path`
  on the row; `lesion_photos`/`symptom_photos` predate the core and carry no
  such column, and phase 3 deliberately shipped **no schema change**, so their
  readers derive it. The thumbnail is a derived artifact of the stored file, not
  an independent fact, so a sibling name encodes it truthfully — and every
  reader `existsSync`es first, falling back to the full image for a photo the
  metadata backfill has not reached.
- `unlinkPhotoFiles(domain, relPaths)` is best-effort and **path-contained**: a
  stored path resolving outside the domain root is skipped, never followed.
- Serve routes follow the lesion/symptom posture, hardened: session-gated,
  scoped `id AND profile_id`, path-contained, `nosniff`, `?thumb=1` for the grid
  asset, and the #478 JSON error shape (`app/api/progress-photo/[id]/route.ts`
  is the reference).

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
  date pickers, side-by-side or an onion-skin overlay with a blend slider, and a
  thumbnail strip for the endpoints.

Captions/meta are factual only (date, weight snapshot) — no scoring, no derived
judgment anywhere in the core (product-decided, #1119).

## Adding a tenant domain (the checklist phase 3 and #1224 followed)

1. Add the domain key + dir to `PhotoDomain`/`DOMAIN_DIRS` in
   `lib/photo/store.ts`.
2. Domain write core (`lib/<domain>-photo-write.ts`, auth-blind, profileId-
   first): validate domain fields → per-profile `contentHash` dedup →
   `storeProcessedPhoto` → row insert, all inside `writeTx`; delete unlinks both
   files. `lib/progress-photo-write.ts` is the template. A METADATA edit (#1934)
   belongs here too and is the split the domain must keep: the row's descriptive
   fields (date, series key, caption) are correctable in place, while
   `stored_path`/`thumb_path`/`content_hash` never appear in an UPDATE's SET list
   — the bytes are immutable content, so a correction can never re-point a row at
   different pixels and the per-profile dedup keeps meaning what it meant.
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
   `PhotoTimeline` per series. A domain whose table predates the core and has no
   `thumb_path` derives the grid's thumbnail with `thumbSiblingPath` instead
   (#1844) — it does NOT earn a schema change for it.

## Phase 3 (#1844) — the other two domains, and the backfill

`lib/skin-photo-write.ts` and `lib/symptom-photo-write.ts` were the last domain
writes storing uploaded bytes verbatim, on the two most sensitive photo domains
in the app. Both now take a `ProcessedPhoto`, exactly like the progress core; both
Server Actions run `processPhoto` → `resolvePhotoDate` → core. Their surfaces
render through the shared views: `LesionPhotoStrip` and `SymptomPhotoStrip` are
Browse (`PhotoGallery`) / Compare (`PhotoTimeline`) over one series — the lesion
for skin, the symptom for illness — which is what "is this mole changing?" and
"is the rash spreading?" actually ask. Both serve routes gained `?thumb=1`.

**The one-time backfill** (`lib/photo/metadata-backfill.ts`) is what makes the
guarantee retroactive. Owner ruling (2026-08-01, #1844): **strip in place** — the
pass re-encodes each stored file through the same `processPhoto` and replaces the
bytes, with no archived-originals tier, because an archive only relocates the
exposure. It is a **boot task, not a versioned migration**: the work is filesystem
work (a migration's transaction cannot roll back re-encoded files), sharp is async
while the runner and `bootTasks` are synchronous by design, and it changes no
schema — it writes only the three byte-derived columns (`mime_type`, `size_bytes`,
`content_hash`). `bootTasks` claims it through a `settings` marker (the
canonical-flag-reconcile pattern) and lets it run detached; the pass logs a
processed / skipped / failed tally. Idempotence is per FILE — a stored JPEG with
no Exif segment is skipped, never re-compressed — so `npm run photo:backfill`
re-runs it safely at any time. A file that cannot be cleaned (undecodable, HEIC)
is counted `failed` and left exactly as it was, never replaced.

## Deliberately out (as of phase 3)

- The **global quick-capture type→target chooser** (camera in the pinned
  quick-actions routing Progress/Skin/Symptom/Document). Phase 3 removed what it
  was waiting on — three domains now ride the core with the same capture,
  storage and gallery contract, so a chooser has real targets to route to and
  each one already accepts the same `ProcessedPhoto`. Still unbuilt, and still a
  product decision (where the entry point lives, what a mis-routed capture
  costs); the in-context capture on `/progress`, the lesion strip, the episode
  strip and the palette's `Add progress photo` action cover today's paths.
- **Offline capture queueing** — the client already downscales before upload so
  a queued blob would be small; wiring the capture flow into the offline write
  queue is future work.
- Lightbox pinch-zoom gestures.
