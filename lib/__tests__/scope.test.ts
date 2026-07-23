import { describe, it, expect } from "vitest";
import { stampSubjects, type ProfileScope } from "@/lib/scope";

// Pure-tier coverage for stampSubjects (lib/scope.ts). resolveScope/requireScope need
// a real DB (the accessible set + access map) and are exercised in the DB tier
// (lib/__db_tests__/scope.test.ts); stampSubjects is pure over an already-resolved
// scope, so it is pinned here against a hand-built ProfileScope.

function scope(
  profiles: { id: number; name: string }[],
  access: Record<number, "read" | "write">
): ProfileScope {
  return {
    loginId: 1,
    role: "member",
    actingProfileId: profiles[0]?.id ?? 0,
    ownProfileId: null,
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      photo_path: null,
      photo_version: 0,
    })),
    ids: profiles.map((p) => p.id),
    viewIds: profiles.map((p) => p.id),
    access: new Map(Object.entries(access).map(([k, v]) => [Number(k), v])),
  };
}

describe("stampSubjects", () => {
  it("stamps each row from the scope's disambiguated profiles + access map", () => {
    const s = scope(
      [
        { id: 10, name: "Alex (1)" },
        { id: 20, name: "Alex (2)" },
      ],
      { 10: "write", 20: "read" }
    );
    const stamped = stampSubjects(s, [
      { profileId: 10, note: "x" },
      { profileId: 20, note: "y" },
    ]);
    expect(stamped[0].subject).toEqual({
      profileId: 10,
      name: "Alex (1)",
      photoPath: null,
      photoVersion: 0,
      access: "write",
    });
    expect(stamped[0].note).toBe("x"); // original fields preserved
    expect(stamped[1].subject.name).toBe("Alex (2)");
    expect(stamped[1].subject.access).toBe("read");
  });

  it("carries the photo path + version through for avatars", () => {
    const s: ProfileScope = {
      loginId: 1,
      role: "admin",
      actingProfileId: 5,
      ownProfileId: null,
      profiles: [
        {
          id: 5,
          name: "Pat",
          photo_path: "medical/5/pic.jpg",
          photo_version: 3,
        },
      ],
      ids: [5],
      viewIds: [5],
      access: new Map([[5, "write"]]),
    };
    const [stamped] = stampSubjects(s, [{ profileId: 5 }]);
    expect(stamped.subject.photoPath).toBe("medical/5/pic.jpg");
    expect(stamped.subject.photoVersion).toBe(3);
  });

  it("falls back to a stable label + most-restrictive read access for an out-of-scope row", () => {
    const s = scope([{ id: 1, name: "Only" }], { 1: "write" });
    const [stamped] = stampSubjects(s, [{ profileId: 99 }]);
    expect(stamped.subject.name).toBe("Profile 99");
    expect(stamped.subject.access).toBe("read");
    expect(stamped.subject.photoPath).toBeNull();
  });

  it("is a pure map — does not mutate the input rows", () => {
    const s = scope([{ id: 1, name: "A" }], { 1: "write" });
    const rows = [{ profileId: 1 }];
    const out = stampSubjects(s, rows);
    expect(rows[0]).not.toHaveProperty("subject");
    expect(out[0]).toHaveProperty("subject");
  });
});
