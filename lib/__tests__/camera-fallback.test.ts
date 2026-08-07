import { describe, expect, it } from "vitest";
import {
  CAMERA_RECOVERY_INSTRUCTIONS,
  cameraDialogVariant,
  cameraRecoveryPlatform,
  cameraStartDecision,
} from "@/lib/photo/camera-fallback";

describe("cameraStartDecision", () => {
  it("uses the picker synchronously for known fallback cases", () => {
    expect(
      cameraStartDecision({
        userInitiated: true,
        hasGetUserMedia: false,
        knowledge: "unknown",
      })
    ).toBe("direct-picker");
    expect(
      cameraStartDecision({
        userInitiated: true,
        hasGetUserMedia: true,
        knowledge: "denied",
      })
    ).toBe("direct-picker");
    expect(
      cameraStartDecision({
        userInitiated: true,
        hasGetUserMedia: true,
        knowledge: "failed",
      })
    ).toBe("direct-picker");
  });

  it("tries an unknown or cached-granted camera", () => {
    for (const knowledge of ["unknown", "granted"] as const) {
      expect(
        cameraStartDecision({
          userInitiated: true,
          hasGetUserMedia: true,
          knowledge,
        })
      ).toBe("try-camera");
    }
  });

  it("keeps auto-open deep links in a dialog because they have no activation", () => {
    expect(
      cameraStartDecision({
        userInitiated: false,
        hasGetUserMedia: false,
        knowledge: "failed",
      })
    ).toBe("show-fallback");
  });
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
