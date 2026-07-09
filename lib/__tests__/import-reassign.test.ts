import { describe, it, expect } from "vitest";
import { canReassignDocument } from "@/lib/import-reassign";

// Pure decision tests for reassign (issue #208, Phase 3), mirroring
// lib/family-deletion. The DB/file move lives in the server action; only the
// "may this login move A → B?" rule is under test here.

describe("canReassignDocument", () => {
  const base = { sourceProfileId: 1, accessibleProfileIds: [1, 2, 3] };

  it("allows a move to a different, accessible profile", () => {
    expect(canReassignDocument({ ...base, destProfileId: 2 })).toEqual({
      ok: true,
    });
  });

  it("rejects a no-op move onto the same profile", () => {
    const d = canReassignDocument({ ...base, destProfileId: 1 });
    expect(d.ok).toBe(false);
  });

  it("rejects a destination the login can't access", () => {
    const d = canReassignDocument({
      sourceProfileId: 1,
      destProfileId: 9,
      accessibleProfileIds: [1, 2],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/destination/i);
  });

  it("rejects when the login can't even reach the source", () => {
    const d = canReassignDocument({
      sourceProfileId: 5,
      destProfileId: 2,
      accessibleProfileIds: [1, 2],
    });
    expect(d.ok).toBe(false);
  });

  it("rejects a missing / invalid destination id", () => {
    expect(canReassignDocument({ ...base, destProfileId: 0 }).ok).toBe(false);
    expect(canReassignDocument({ ...base, destProfileId: -1 }).ok).toBe(false);
  });
});
