# The shared video core (`lib/video/*`, `components/video/*`)

Status: shipped (phase 1 — upload-only)

The upload → sniff → store → serve/browse stack every video-carrying domain uses
(issue #1224, phase 1). The **symptom / episode clip** domain (`symptom_videos`)
and the **training form-check** domain (`activity_videos`) are its first two
tenants. It is the deliberate **sibling of the #1119 photo core** — same
per-profile store conventions, same strictest-privacy tier — with the parts
video needs that photos don't: container sniffing, duration/creation-time
parsing, a Range-capable serve, and a poster frame.

## Why one core (the chokepoint argument)

The photo core exists because three photo domains each re-implemented a partial
slice of storage/sniffing/serving and none stripped metadata. Video would repeat
that mistake at higher stakes (a clip carries GPS in a `©xyz` atom, and it's
big). One `ingestVideo()` funnel + one `serveRangedFile()` helper keep the
sniff, cap, dedup, and byte-serving behavior identical across every current and
future video domain. The privacy tier is **strictest** (physique-photo level):
per- profile grants, **excluded from share links / the emergency card / the
default export** structurally (no such path reads these tables), serve scoped
`id AND profile_id`, path-contained. Since #1846 there is exactly ONE more
egress, and it is user-initiated per download: the export flow's "Include photo &
video files" opt-in (see [Export](#export-1846) below).

## No native dependency (the `ffmpeg` line — the #1119 `sharp` twin)

The photo core flags that it takes a native dep (`sharp`) because the EXIF strip
is correctness-critical. The video core makes the **opposite** call and flags it
just as loudly: **there is no `ffmpeg`-class dependency.** Everything is
byte-level container parsing in pure TS (`lib/video-sniff.ts`):

- **Container detection** by magic — ISO-BMFF `ftyp` brands → `video/mp4` /
  `video/quicktime` (and `M4A `/audio-only-track → `audio/mp4`); EBML →
  `video/ webm` / `audio/webm`; plus coarse `OggS`/MP3 sniffing for voice notes.
  The server-trusted MIME is derived from the bytes, **never** the
  client-declared type.
- **Duration** from the `mvhd` box (ISO-BMFF) or `Info/Duration` (EBML), so the
  **60s cap is enforced server-side without decoding a frame**. Containers we
  can't cheaply measure (Ogg/MP3) report `null` duration and pass the length
  gate — the **100 MB byte cap** is the always-on guard.
- **Creation time** from `mvhd` (the 1904 epoch) as the clip's **default capture
  date** — the #1119 harvest-then-note twin (the photo core
  harvests-then-_strips_; here the file is stored **as-is**, so we
  harvest-then-_note_).
- **Location detection**: a QuickTime `©xyz` atom or the
  `com.apple.quicktime.location.ISO6709` key sets a `has_location` flag that
  drives a visible privacy note. **The coordinate is never decoded** — no field
  of the sniff result can carry a location (the photo core's GPS posture).
  Because there is no remux, a location-tagged upload keeps its metadata on
  disk; the note steers users toward the phase-2 in-app recording path, which is
  metadata-clean by construction (a MediaRecorder blob carries no GPS).

`lib/video-sniff.ts` is fully unit-tested over **synthetic, low-entropy** byte
fixtures built by `lib/video/fixture.ts` (a real `ftyp`/`moov` tree and a real
EBML `Segment` tree — no real recording, nothing a secret scanner trips).

## The pipeline (server)

1. **`ingestVideo(bytes)`** (`lib/video/ingest.ts`) — gate empty/oversize →
   sniff → enforce the 60s cap against the sniffed duration → sha256 of the
   **original** bytes (dedup). Returns `{ kind: "ingested", video }` or
   `{ kind: "invalid", error }`; callers never unconditionally confirm.
2. **Poster** — the client extracts one frame to a canvas
   (`lib/video/client-poster.ts`, best-effort) and submits it as a JPEG; the
   server runs it through the **#1119 photo strip pipeline**
   (`lib/video/poster.ts` → `processPhoto`), so the stored poster is EXIF-clean
   exactly like every other image. An audio clip or an undecodable frame simply
   has no poster (the grid shows a placeholder).
3. **Store** (`lib/video/store.ts`) — write the clip **as-is**
   (`<hash16>.<ext>`) and the poster (`<hash16>.poster.jpg`) under
   `data/uploads/<domain>-videos/<profileId>/`; path-contained unlink.
4. **Domain write core** — `lib/symptom-video-write.ts` /
   `lib/activity-video-write.ts` own the row + per-profile content-hash dedup,
   all inside `writeTx`; delete unlinks both files.

## Serve — Range, the app's first non-whole-file serve

`serveRangedFile()` (`lib/video/serve.ts`) honors `Range: bytes=start-end` with
a `206 Partial Content` + `Content-Range` (scrubbing), advertises
`Accept-Ranges`, sets `nosniff`, and streams the file (Node `fs` → web stream).
Both serve routes (`app/api/symptom-video/[id]`, `app/api/activity-video/[id]`)
reuse it, and a `?poster=1` param serves the poster JPEG through the same
helper. Both are session-gated, path-contained, and use the #478 JSON error
shape.

The two routes differ in **which** profiles they accept, because their surfaces
do:

- `/api/activity-video/[id]` is scoped `id AND profile_id` — the training
  surfaces that render it are active-profile pages.
- `/api/symptom-video/[id]` resolves the clip's **owning** profile from the row
  and gates the session against **that** profile (`canAccessProfile`, #1696).
  The episode page that renders the strip resolves the episode across the
  viewer's **accessible** profiles (#879), so active-profile scoping 404'd every
  clip a caregiver looked at. `/api/symptom-photo/[id]`, the twin strip on the
  same page, takes the identical posture.

An inaccessible profile's row is refused with the **same** response as a
nonexistent id, so neither route reveals whether some other family's id exists.

## Surfaces (one shared grid, two thin wrappers — #221)

`components/video/VideoClipGrid.tsx` is the one capture → poster-grid → open-to-
play surface: a native file input (`accept="video/*,audio/*" capture`), a
poster- first grid (the `<video>`/`<audio>` element loads **only on open**), the
location privacy note, and caption edit / delete. Two thin wrappers wire it to
their domain's actions:

- `components/illness/SymptomVideoStrip.tsx` — on the episode page
  (`/medical/episodes/[id]`), cross-profile gated (`profileId` → the household
  member), the `SymptomPhotoStrip` twin.
- `components/activity/ActivityVideoStrip.tsx` — the training tenant,
  active-profile scoped. It renders in **two placements**, split by `showAdd`
  (#1457):
  - **Journal card** (`/training`, no `showAdd`) — a READ surface: playback,
    caption edit, delete, privacy note, threaded through the journal feed
    (`buildJournalFeedPage` → `JournalCardData.videos`). It renders **only when
    clips exist**. Until #1457 it rendered for every writable activity
    regardless of type or content, so a Strava easy run, a walk, and an imported
    swim each carried a "Form check" heading, a "No clips…" line, and a button —
    permanent vertical cost on every card (the #1416/#1455 density concern) for
    an affordance that was loudest where it was least useful.
  - **Activity editor** (`components/activity-form/ActivityFormCheck.tsx` inside
    `ActivityMoreDetails`, `showAdd`) — the WRITE surface, where a clip is
    attached. It always renders, empty state included. **Edit mode only**, and
    that is a data constraint: `activity_videos` needs an `activityId`, which
    the editor's create mode has none of until save, so during first-time
    logging the block appears once the activity is saved and reopened. Deferred
    upload (hold the file client-side until save) was weighed and rejected — a
    client-held-blob lifecycle (navigation loss, size limits, retry semantics)
    for a marginal flow; in-session capture, if ever wanted, rides the live
    editor's own id timing (#924). There is **no activity-type gate** (owner
    call): a clip on a run is unusual but legitimate, and a heuristic would be
    one more thing to maintain. Unlike the card it is not handed clips by a
    server component — the editor is a client component opened from several
    entry points, so it reads them through `listActivityVideosAction` and
    re-reads after an upload/delete.

## Row-ops side-state (#199/#200/#201/#212)

- Both tables are **profile-owned** (`lib/owned-tables.ts`); `deleteProfile`
  clears the rows and unlinks their files (clip + poster) path-contained.
- Both are in the **export-completeness allowlist** with the strictest-tier
  reason — still out of the DEFAULT export, now pointing at the #1846 opt-in
  rather than at a follow-up (see below).
- `activity_videos.activity_id` carries **`ON DELETE CASCADE`**, so a plain
  activity delete removes its clips — and the rows are **captured into the undo
  buffer** first (`UNDO_KINDS.activity`) so a mis-tap delete is undoable, and
  are **re-parented onto the keeper on a merge** (`writeActivityFold`) so a
  merge never loses a clip. (Merge-undo leaves re-parented clips on the keeper —
  a documented, clip-preserving deviation; the clip is never lost, only
  re-homed.)
- **Purge-time file cleanup** (#1290): the clip files deliberately survive the
  delete→undo window on disk so a restore re-points at them, but a capture that
  EXPIRES without being restored has its files unlinked — the sweep collects the
  captured paths before the holding rows are deleted and unlinks each one no
  live row still references (content-hash dedup means a re-upload can share the
  file). Since #2013 the two by-hand purges — "Delete permanently" on one Trash
  row and "Empty trash" — route through the same collect-then-unlink path, so a
  clip can never outlive the last row pointing at it. The window those files
  live for is the admin-configured Trash retention (30 days by default), which
  is why the setting's help text names clips explicitly.

## Export (#1846)

The strictest-tier default is **exclude**, and that has not changed. What changed
is that "excluded" no longer means "unreachable": the full-account export carries
one checkbox, **"Include photo & video files"**, which adds `?media=1` to the
download. Everything about it is deliberate:

- **One toggle for both cores.** Clips are not a separate privacy question from
  physique or lesion photos, so they do not get a separate control. The toggle
  covers all five media domains — `progress_photos`, `lesion_photos`,
  `symptom_photos`, `symptom_videos`, `activity_videos` — declared in
  `MEDIA_DOMAINS` (`lib/export-full.ts`).
- **Per download, never stored.** The route reads the query param and nothing
  else; there is no setting, so an inclusive export cannot silently become the
  standing default for the next one.
- **Layout.** Files go to `media/<domain>/<rowId>-<storedName>` and the row
  context goes to `media/index.json`, keyed by domain. That index IS the row
  export for these tables — which is why they stay OUT of `DATASETS` while being
  IN the bundle: a bare date/caption row is only meaningful beside its file. The
  manifest gains a `contents.media` section and a `totals.mediaFiles` count kept
  separate from the medical-document `files` count.
- **Posters and thumbnails are not bundled.** They are derived artifacts; the
  original capture is the record.
- **Scoping is double-locked.** Every domain SELECT filters the exporting
  profile's own `profile_id`, and each `stored_path` must then resolve inside
  `<domainRoot>/<profileId>/` — the domain roots come from the stores' own path
  helpers, so a corrupt or tampered path is skipped rather than followed. A
  training-restricted profile's `activity_videos` are held back too, because
  `activities` is already gated out of the ZIP (#471) and clips must not be the
  way around it.
- **The bytes still stream.** One clip can be hundreds of megabytes, so the route
  reads and yields one entry at a time exactly as it does for medical uploads.

Covered by `lib/__db_tests__/export-media.test.ts` (scoping, containment, row
context, the age gate) and `e2e/export-media.spec.ts` (the rendered toggle, the
default-off archive, the opted-in archive).

## Deliberately out (phase 2 / follow-ups)

- **In-app MediaRecorder recording** — the clean-metadata path the upload
  warning steers toward (bitrate/resolution caps, a poster-ghost onion-skin for
  form checks, offline-queue integration). Native upload stays the fallback.
- No AI (matches #1119): no form scoring, pose estimation, or episode
  classification — factual capture, tagging, and playback only.
