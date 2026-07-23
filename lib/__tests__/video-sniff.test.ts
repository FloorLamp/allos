// PURE tier — container sniffing for uploaded video/audio clips (#1224). Every
// fixture is built by lib/video/fixture.ts from LOW-ENTROPY, obviously-synthetic
// bytes (fixed brands, zero-padded boxes) — no real recording, and nothing a
// secret scanner trips. Mirrors lib/__tests__/file-sniff.test.ts.

import { describe, it, expect } from "vitest";
import { sniffVideo } from "@/lib/video-sniff";
import {
  buildMp4Fixture,
  buildMovFixture,
  buildM4aFixture,
  buildWebmFixture,
  buildOggFixture,
  buildMp3Fixture,
} from "@/lib/video/fixture";

describe("sniffVideo — container detection", () => {
  it("detects an MP4 (ftyp isom) as video/mp4", () => {
    const s = sniffVideo(buildMp4Fixture());
    expect(s).not.toBeNull();
    expect(s!.mime).toBe("video/mp4");
    expect(s!.container).toBe("mp4");
    expect(s!.kind).toBe("video");
  });

  it("detects a QuickTime .mov (major brand 'qt  ') as video/quicktime", () => {
    const s = sniffVideo(buildMovFixture());
    expect(s!.mime).toBe("video/quicktime");
    expect(s!.container).toBe("quicktime");
    expect(s!.kind).toBe("video");
  });

  it("detects a WebM (EBML doctype webm) as video/webm", () => {
    const s = sniffVideo(buildWebmFixture());
    expect(s!.mime).toBe("video/webm");
    expect(s!.container).toBe("webm");
    expect(s!.kind).toBe("video");
  });

  it("detects an .m4a (brand 'M4A ') as audio/mp4", () => {
    const s = sniffVideo(buildM4aFixture());
    expect(s!.mime).toBe("audio/mp4");
    expect(s!.kind).toBe("audio");
  });

  it("detects an audio-ONLY mp4 (soun handler, no video track) as audio", () => {
    const s = sniffVideo(buildMp4Fixture({ handler: "soun" }));
    expect(s!.kind).toBe("audio");
    expect(s!.mime).toBe("audio/mp4");
  });

  it("detects an audio-only WebM (TrackType audio) as audio/webm", () => {
    const s = sniffVideo(buildWebmFixture({ trackType: 2 }));
    expect(s!.mime).toBe("audio/webm");
    expect(s!.kind).toBe("audio");
  });

  it("detects Ogg and MP3 audio containers (duration unmeasured)", () => {
    const ogg = sniffVideo(buildOggFixture());
    expect(ogg!.mime).toBe("audio/ogg");
    expect(ogg!.kind).toBe("audio");
    expect(ogg!.durationSec).toBeNull();

    const mp3 = sniffVideo(buildMp3Fixture());
    expect(mp3!.mime).toBe("audio/mpeg");
    expect(mp3!.durationSec).toBeNull();
  });

  it("returns null for a non-container file and for a too-short buffer", () => {
    expect(
      sniffVideo(Buffer.from("just some plain text, not a container"))
    ).toBeNull();
    expect(sniffVideo(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    // A PNG is an image, not a video container.
    expect(
      sniffVideo(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
        ])
      )
    ).toBeNull();
  });
});

describe("sniffVideo — duration parse (the 60s-cap input)", () => {
  it("reads the mvhd duration/timescale for an MP4", () => {
    expect(
      sniffVideo(buildMp4Fixture({ durationSec: 10, timescale: 600 }))!
        .durationSec
    ).toBe(10);
    expect(sniffVideo(buildMp4Fixture({ durationSec: 75 }))!.durationSec).toBe(
      75
    );
  });

  it("reads the Info/Duration for a WebM (timecode-scaled)", () => {
    const s = sniffVideo(buildWebmFixture({ durationSec: 12 }));
    expect(s!.durationSec).toBeCloseTo(12, 2);
  });

  it("reports null duration when the mvhd carries none (timescale/duration 0)", () => {
    const s = sniffVideo(buildMp4Fixture({ durationSec: 0 }));
    expect(s!.durationSec).toBeNull();
  });
});

describe("sniffVideo — creation-time harvest (default capture date)", () => {
  it("harvests the mvhd creation_time (1904 epoch) as a YYYY-MM-DD date", () => {
    const s = sniffVideo(buildMp4Fixture({ creationDate: "2026-03-14" }));
    expect(s!.creationDate).toBe("2026-03-14");
  });

  it("harvests a different date correctly (epoch math is not fixed)", () => {
    const s = sniffVideo(buildMp4Fixture({ creationDate: "2019-11-02" }));
    expect(s!.creationDate).toBe("2019-11-02");
  });

  it("reports null creation date when the mvhd creation_time is unset (0)", () => {
    // No creationDate option → creation_time 0 → null.
    expect(sniffVideo(buildMp4Fixture())!.creationDate).toBeNull();
  });
});

describe("sniffVideo — location-atom detection (never decoded)", () => {
  it("flags a clip carrying a QuickTime ©xyz location atom", () => {
    const s = sniffVideo(buildMp4Fixture({ location: true }));
    expect(s!.hasLocation).toBe(true);
    // The result shape carries NO coordinate field — presence only.
    expect(Object.keys(s!)).toEqual(
      expect.arrayContaining([
        "mime",
        "container",
        "kind",
        "durationSec",
        "creationDate",
        "hasLocation",
      ])
    );
    expect(Object.keys(s!)).toHaveLength(6);
  });

  it("does not flag a clip with no location atom", () => {
    expect(sniffVideo(buildMp4Fixture({ location: false }))!.hasLocation).toBe(
      false
    );
    // A MediaRecorder-style WebM never carries location.
    expect(sniffVideo(buildWebmFixture())!.hasLocation).toBe(false);
  });
});
