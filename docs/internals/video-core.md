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
`id AND profile_id`, path-contained.

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
  reason (excluded from the default export, opt-in follow-up).
- `activity_videos.activity_id` carries **`ON DELETE CASCADE`**, so a plain
  activity delete removes its clips — and the rows are **captured into the undo
  buffer** first (`UNDO_KINDS.activity`) so a mis-tap delete is undoable, and
  are **re-parented onto the keeper on a merge** (`writeActivityFold`) so a
  merge never loses a clip. (Merge-undo leaves re-parented clips on the keeper —
  a documented, clip-preserving deviation; the clip is never lost, only
  re-homed.)

## Deliberately out (phase 2 / follow-ups)

- **In-app MediaRecorder recording** — the clean-metadata path the upload
  warning steers toward (bitrate/resolution caps, a poster-ghost onion-skin for
  form checks, offline-queue integration). Native upload stays the fallback.
- **Opt-in export** of clips (the strictest-tier default is exclude).
- **File cleanup on undo-buffer purge** — a deleted-then-not-undone activity's
  clip files linger until the profile is deleted (content-named, small);
  explicit purge-time unlink is a follow-up.
- No AI (matches #1119): no form scoring, pose estimation, or episode
  classification — factual capture, tagging, and playback only.
