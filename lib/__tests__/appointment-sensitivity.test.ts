import { describe, it, expect } from "vitest";
import {
  sharedSurfaceDetail,
  kindDefaultsToMinimalShared,
} from "@/lib/appointment-sensitivity";

// #997 — a mental_health visit defaults to MINIMAL detail on shared/exported
// surfaces even when the surface asks for "full", overridable by the owner. Every
// other kind honors the requested detail unchanged.
describe("kindDefaultsToMinimalShared", () => {
  it("is true only for mental_health", () => {
    expect(kindDefaultsToMinimalShared("mental_health")).toBe(true);
    expect(kindDefaultsToMinimalShared("physical")).toBe(false);
    expect(kindDefaultsToMinimalShared("dental")).toBe(false);
    expect(kindDefaultsToMinimalShared("vision")).toBe(false);
    expect(kindDefaultsToMinimalShared(null)).toBe(false);
    expect(kindDefaultsToMinimalShared(undefined)).toBe(false);
  });
});

describe("sharedSurfaceDetail", () => {
  it("forces mental_health to minimal on a full-detail shared surface by default", () => {
    expect(sharedSurfaceDetail("mental_health", "full")).toBe("minimal");
  });

  it("honors the owner's override to show mental_health in full", () => {
    expect(
      sharedSurfaceDetail("mental_health", "full", { sensitiveShareFull: true })
    ).toBe("full");
  });

  it("keeps mental_health minimal when the surface is already minimal", () => {
    expect(sharedSurfaceDetail("mental_health", "minimal")).toBe("minimal");
    expect(
      sharedSurfaceDetail("mental_health", "minimal", {
        sensitiveShareFull: true,
      })
    ).toBe("minimal");
  });

  it("passes other kinds through unchanged (no down-levelling, no override effect)", () => {
    for (const detail of ["minimal", "full"] as const) {
      expect(sharedSurfaceDetail("physical", detail)).toBe(detail);
      expect(sharedSurfaceDetail("dental", detail)).toBe(detail);
      expect(sharedSurfaceDetail(null, detail)).toBe(detail);
      expect(
        sharedSurfaceDetail("physical", detail, { sensitiveShareFull: true })
      ).toBe(detail);
    }
  });
});
