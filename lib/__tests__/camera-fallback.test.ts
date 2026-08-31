import { describe, expect, it } from "vitest";
import {
  CAMERA_RECOVERY_INSTRUCTIONS,
  cameraDialogVariant,
  cameraRecoveryPlatform,
  mediaStartStage,
  type CameraKnowledge,
} from "@/lib/photo/camera-fallback";

// WHICH STAGE THE ADD-MEDIA DIALOG OPENS ON (#3286). The whole matrix, because
// the defect was one cell of it: a wide viewport with a camera nobody had ever
// granted opened the CAMERA stage, failed, and left permission instructions as
// the dialog's opening line with the file path demoted to a sentence.
//
// Read the last column as the answer to "is the camera a plausible primary
// here": known-bad never leads, known-good always leads, and unknown follows the
// viewport, which is the only honest signal available before an attempt.
describe("mediaStartStage", () => {
  const cases: [string, boolean, CameraKnowledge, boolean, string][] = [
    // label, hasGetUserMedia, knowledge, compactViewport, expected
    ["no camera API at all", false, "unknown", true, "chooser"],
    ["no camera API, wide", false, "granted", false, "chooser"],
    ["denied, phone-width", true, "denied", true, "chooser"],
    ["denied, wide", true, "denied", false, "chooser"],
    ["failed, phone-width", true, "failed", true, "chooser"],
    [
      "unreadable permissions, phone-width",
      true,
      "unreadable",
      true,
      "chooser",
    ],
    ["granted, phone-width", true, "granted", true, "camera"],
    ["granted, wide", true, "granted", false, "camera"],
    ["unknown, phone-width", true, "unknown", true, "camera"],
    ["unknown, wide (the #3286 defect)", true, "unknown", false, "chooser"],
  ];
  it.each(cases)(
    "%s",
    (_label, hasGetUserMedia, knowledge, compactViewport, expected) => {
      expect(
        mediaStartStage({ hasGetUserMedia, knowledge, compactViewport })
      ).toBe(expected);
    }
  );
});

describe("camera fallback diagnosis", () => {
  it("maps rejection names and permission denial to the guided variants", () => {
    expect(cameraDialogVariant("NotAllowedError")).toBe("blocked");
    expect(cameraDialogVariant("UnknownError", "denied")).toBe("blocked");
    expect(cameraDialogVariant("NotFoundError")).toBe("not-found");
    expect(cameraDialogVariant("NotReadableError")).toBe("in-use");
    expect(cameraDialogVariant("AbortError")).toBe("unknown");
  });

  it("selects the small declared platform registry with a generic tail", () => {
    expect(
      cameraRecoveryPlatform({ userAgent: "Android Chrome", standalone: true })
    ).toBe("android-pwa");
    expect(
      cameraRecoveryPlatform({ userAgent: "Android Chrome", standalone: false })
    ).toBe("android-chrome");
    expect(
      cameraRecoveryPlatform({ userAgent: "iPhone Safari", standalone: true })
    ).toBe("ios");
    expect(
      cameraRecoveryPlatform({
        userAgent: "Mozilla Windows",
        standalone: false,
      })
    ).toBe("desktop");
    expect(
      cameraRecoveryPlatform({ userAgent: "Mystery", standalone: false })
    ).toBe("generic");
    expect(CAMERA_RECOVERY_INSTRUCTIONS.generic[0]).toContain(
      "browser's site settings"
    );
  });
});
