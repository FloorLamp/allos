# Shared video core

Status: shipped, upload-only

Symptom/episode clips (`symptom_videos`) and activity clips (`activity_videos`)
share ingest, storage, serving, and playback. They use the [photo core](photo-core.md)
for poster processing and share its [media export contract](photo-core.md#shared-media-export).

## Ingest and privacy

[ingestVideo](../../lib/video/ingest.ts) rejects empty or oversized input, sniffs the
container, checks the parsed duration, and hashes the original bytes. It returns an
ingested clip or a typed invalid result. Callers must handle refusal before writing.

[Video policy](../../lib/video/policy.ts) sets a 100 MiB byte cap and a nominal
60-second duration cap with one second of grace. Unknown duration passes the
length gate; the byte cap still applies. This is a container-level check, not a
promise that every accepted recording is at most 60 seconds long.

[Container sniffing](../../lib/video-sniff.ts) derives MIME and video/audio kind
from bytes rather than the upload's declared type. It recognizes MP4/QuickTime,
WebM, and supported audio containers; MP4 and WebM metadata can supply duration.
QuickTime creation time can supply a default capture date. For dated clips, a
valid explicit date wins, then a container date no later than today, then today.

There is no server video decoder or remux step. Clips are stored as uploaded,
including container metadata. Recognized QuickTime location atoms/keys set the
`hasLocation` flag without decoding coordinates. The UI displays a privacy note
for that flag; absence of the flag does not prove a container is metadata-free.
Do not describe video ingest as the photo core's metadata stripping.

## Posters and storage

[Client poster extraction](../../lib/video/client-poster.ts) tries to capture one
frame to a JPEG canvas image. [posterBytesFrom](../../lib/video/poster.ts) runs
that image through `processPhoto` and returns cleaned JPEG bytes or `null`.
Missing, invalid, or undecodable posters do not block the clip upload; audio clips
can display a placeholder.

[Video storage](../../lib/video/store.ts) writes `<hash16>.<ext>` and, when present,
`<hash16>.poster.jpg` under `data/uploads/<domain>-videos/<profileId>/`. Extensions
come from the sniffed MIME. Identical content uses the same file names.

[Symptom writes](../../lib/symptom-video-write.ts) and
[activity writes](../../lib/activity-video-write.ts) own profile-scoped row
validation, content-hash deduplication, and `writeTx`. File writes happen within
that workflow but cannot be rolled back by SQLite. Reuse the existing contained
unlink helper for clip/poster pairs.

## Serving

[serveRangedFile](../../lib/video/serve.ts) streams a contained absolute path. It
supports one byte range, including suffix and open-ended ranges: valid ranges
return 206 with `Content-Range`, invalid or unsatisfiable ranges return 416, and
requests without a range return 200. Responses advertise byte ranges and set
`nosniff` and private revalidation caching. Missing files return 410.

The helper does not authorize reads or contain paths. The
[activity route](../../app/api/activity-video/[id]/route.ts) and
[symptom route](../../app/api/symptom-video/[id]/route.ts) do that first: require a
session, resolve the clip's owning profile, require `canAccessProfile`, and contain
the stored path within the domain root. Both support household views without
switching the active profile. An inaccessible row and a nonexistent id get the
same not-found response. `?poster=1` uses the same serving helper for the JPEG and
returns 404 when no poster exists.

## Surfaces

[VideoClipGrid](../../components/video/VideoClipGrid.tsx) uses the shared
`MediaInput` chooser with `accept="video/*,audio/*"`. It shows posters, loads the
video/audio player only on open, and provides caption editing, deletion, and the
location note. The photo viewfinder does not record video. In-app MediaRecorder
capture and offline clip queueing remain unimplemented.

`SymptomVideoStrip` connects episode actions and profile context.
`ActivityMediaStrip` has two placements:

- Activity detail supplies existing media for playback, caption editing, and
  deletion; an empty collection hides the section.
- The activity editor uses `showAdd` and includes the empty upload state once an
  activity row exists. Create forms receive that row id from autosave, so upload
  does not require closing and reopening. The editor re-reads media after upload
  or deletion. Any activity type can have media.

Keep capture, labels, and playback factual. This core does not score form, estimate
poses, or classify episodes. Check [refresh rules](server-action-refresh.md) when
wiring writes; an action that already revalidates needs no extra client refresh.

## Row and file lifetime

Both tables are profile-owned. Profile deletion gathers and unlinks clip and
poster files. A direct clip deletion uses its domain write core's cleanup.

Activity deletion captures clips for undo before the foreign-key cascade removes
the live rows. Their files survive that undo window. Expiry and explicit permanent
trash deletion collect retained paths and unlink files with no remaining live
reference; content-based file naming can let a re-upload share a path. Follow the
[trash contract](trash.md), including its configurable retention, rather than
unlinking files immediately from an undoable parent delete.

[Activity merge](../../lib/merge-activity.ts) reparents clips to the keeper.
Merge undo leaves those clips on the keeper, preserving them without restoring
the original parent assignment. New activity children must declare their merge
behavior in the existing `ACTIVITY_CHILD_LINKS` owner.

Use existing synthetic container fixtures and coverage for sniffing, range
handling, domain writes, and media export. Add coverage only for a meaningful
behavior gap; do not create another media test harness.
