import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findTags, scanDirs, walkTsx, REPO } from "./jsx-tag-scan";

// ONE ADD-MEDIA SURFACE (#3286). The acceptance criterion is "a scan pins that
// no second media-input implementation remains", and this is that scan.
//
// WHAT IT KEYS ON, AND WHY NOT A FILENAME. A census over files called
// *Photo*/*Media*/*Upload* would have missed every case that actually existed:
// the second implementations were living INSIDE their consumers — a bare
// `<input type="file" accept="image/*" capture="environment">` in the middle of
// components/illness/SymptomPhotoStrip.tsx, another in the skin lesion strip,
// another in the video clip grid. So the scan keys on the CONSTRUCT, over every
// .tsx in app/ and components/, and it keys on all the spellings this repo
// actually uses rather than the one the issue happened to name:
//
//   1. a `<input type="file">` tag whose `accept` names image, video or audio;
//   2. a `<input type="file">` tag carrying `capture` — a camera-directed input
//      is a media input whatever it claims to accept;
//   3. `getUserMedia` — a live camera needs no <input> at all;
//   4. `dataTransfer.files` / `clipboardData.files` — a drop or paste ingest,
//      which is a way IN that renders no picker.
//
// 3 and 4 are the half a tag scan is structurally blind to: a hand-rolled drop
// zone that writes files straight into a FormData never spells `<input`. They
// are separate sweeps below, not one union, so a failure says which kind.
//
// WHAT IT IS NOT: no ratchet, no frozen count, no growing allowlist. Membership
// is single ownership. The ONE declared non-member below states its reason and
// is asserted in BOTH directions, so if it ever migrates the entry goes stale
// and fails rather than quietly permitting an empty claim.

const SCAN_DIRS = ["app", "components"];

/** The one legitimate home of a media input. */
const OWNER = "components/media/MediaInput.tsx";

/**
 * Declared non-members: a media-shaped input that is NOT an add-media surface.
 * `inputs` is exact in both directions — too few is as much a failure as too
 * many, because a stale entry is a claim about a file that no longer matches it.
 */
const NOT_ADD_MEDIA = new Map<string, { inputs: number; why: string }>([
  [
    "components/PhotoPicker.tsx",
    {
      inputs: 1,
      why:
        "the AVATAR pick→crop control, not an add-media surface: its output is " +
        "a cropped square written to a profile FIELD, and the input IS the " +
        "visible affordance in two declared sizes (#1450), feeding ImageCropper " +
        "directly. Routing it through the shared dialog would stack a chooser, " +
        "a confirm step and the cropper on one act. Not a named consumer of " +
        "#3286; open as a question rather than settled",
    },
  ],
]);

/**
 * A `<input type="file">` that is asking for MEDIA.
 *
 * THE DYNAMIC-ACCEPT CASE IS NOT AN EDGE CASE, it is the owner. The reader
 * strips braced attribute values (their contents are code), so `accept={accept}`
 * reaches this predicate as a bare `accept=` with no literal — and the first
 * draft, which required a quoted literal naming image/video/audio, was blind to
 * the one input this whole scan is about. The positive control above is what
 * caught it. A picker whose accept is COMPUTED is a shared picker by
 * construction, so it counts.
 */
function mediaFileInputs(text: string): number[] {
  return findTags(text, "input", (attrs) => {
    if (!/(?:^|\s)type\s*=\s*"file"/.test(attrs)) return false;
    if (/(?:^|\s)capture\b/.test(attrs)) return true;
    const accept = /(?:^|\s)accept\s*=\s*(?:"([^"]*)")?/.exec(attrs);
    if (!accept) return false;
    if (accept[1] === undefined) return true;
    return /image|video|audio/.test(accept[1]);
  });
}

/** Line numbers of a raw text marker, comments and strings included. */
function markerLines(text: string, marker: RegExp): number[] {
  return text
    .split("\n")
    .map((line, i) => (marker.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

const HOW = [
  "A second media-input implementation. Every add-media surface in this app",
  "renders <MediaInput> (components/media/MediaInput.tsx) — it owns the picker,",
  "the drop zone, the paste handler, the camera and the batch confirm, so a",
  "desktop cannot end up with a camera-shaped dead end and a phone cannot end up",
  "with a bare file field. Render it instead of hand-rolling an input, a",
  "getUserMedia call or a drop handler.",
].join("\n");

describe("one add-media surface (#3286)", () => {
  const inputs = scanDirs(SCAN_DIRS, mediaFileInputs);

  it("the owner renders exactly one media input — the scan is not vacuous", () => {
    // A guard whose candidate set is empty passes wherever it sits. This is the
    // positive control: if the owner's own input stops matching, the sweep below
    // is green because it is blind, not because the tree is clean.
    expect(inputs.get(OWNER)).toHaveLength(1);
  });

  it("no other file renders one, beyond the declared non-members", () => {
    const offenders: string[] = [];
    for (const [rel, lines] of inputs) {
      if (rel === OWNER || NOT_ADD_MEDIA.has(rel)) continue;
      offenders.push(`${rel}:${lines.join(",")}`);
    }
    expect(offenders, `${HOW}\n\n${offenders.join("\n")}`).toEqual([]);
  });

  it.each([...NOT_ADD_MEDIA])(
    "%s is still the shape its entry describes",
    (rel, entry) => {
      expect(inputs.get(rel) ?? [], entry.why).toHaveLength(entry.inputs);
    }
  );

  // The two sweeps a tag scan cannot see. Both are raw-text, comments included,
  // because a mention is cheap to move into prose and a false positive here
  // costs one word; missing a real one costs the criterion.
  it.each([
    ["a live camera", /navigator\.mediaDevices|getUserMedia/],
    ["a drop or paste ingest", /dataTransfer\.files|clipboardData\.files/],
  ])("%s is opened in the owner and nowhere else", (_what, marker) => {
    const hits: string[] = [];
    for (const d of SCAN_DIRS) {
      const abs = path.join(REPO, d);
      if (!fs.existsSync(abs)) continue;
      for (const full of walkTsx(abs)) {
        const rel = path.relative(REPO, full).split(path.sep).join("/");
        if (rel === OWNER) continue;
        const lines = markerLines(fs.readFileSync(full, "utf8"), marker);
        if (lines.length > 0) hits.push(`${rel}:${lines.join(",")}`);
      }
    }
    expect(hits, `${HOW}\n\n${hits.join("\n")}`).toEqual([]);
  });
});

// PROVE THE READER CAN SEE. A green sweep over a complying tree says nothing
// about what the sweep can see, so these are sources authored to break it —
// including the three real shapes this issue migrated, and the benign
// neighbours the guard must stay silent on (a .zip archive picker is not media,
// and neither is a text field).
describe("the media-input reader", () => {
  it.each([
    ['<input type="file" accept="image/*" />', [1]],
    ['<input type="file" accept="video/*,audio/*" capture="environment" />', [1]],
    // The tag that started the issue: attributes across lines, an arrow inside a
    // brace, and the accept two lines from the tag name.
    [
      '<input\n  ref={r}\n  type="file"\n  accept="image/*"\n  capture="environment"\n  onChange={(e) => go(e.target.files?.[0] ?? null)}\n/>',
      [1],
    ],
    // capture alone is enough: a camera-directed input is a media input.
    ['<input type="file" capture />', [1]],
    // The documents picker: media is in the middle of a long accept list.
    [
      '<input type="file" accept=".pdf,.xlsx,image/*,.zip,.xml" multiple />',
      [1],
    ],
    // Benign neighbours — the guard must stay quiet, or it gets suppressed and
    // takes the real guard with it.
    ['<input type="file" accept=".zip,application/zip" />', []],
    // A computed accept is the owner's own shape, and the first draft of this
    // predicate could not see it.
    ["<input type=\"file\" accept={accept} multiple={multiple} />", [1]],
    ['<input type="text" accept="image/*" />', []],
    ['<IconImage type="file" accept="image/*" />', []],
    ['// a bare <input type="file" accept="image/*"> used to live here', []],
    ['const s = \'<input type="file" accept="image/*">\';', []],
  ])("%s", (source, expected) => {
    expect(mediaFileInputs(source)).toEqual(expected);
  });
});
