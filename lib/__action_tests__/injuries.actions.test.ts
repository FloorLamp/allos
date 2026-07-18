// SERVER-ACTION TIER — the injury layer write path (issue #838).
//
// Drives the real Server Actions (log / update / status / delete / situation bridge)
// against the in-memory SQLite handle with the auth boundary mocked (setup.ts). Pins: a
// log lands active with parsed regions; a missing region/label is refused; status moves
// stamp/clear resolved_date; delete removes the row; the bridge activates the "Injury"
// situation; and each write revalidates /training + /timeline.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  logInjury,
  updateInjury,
  setInjuryStatus,
  deleteInjury,
  activateInjurySituation,
} from "@/app/(app)/training/injury-actions";
import { getInjuries } from "@/lib/injuries";
import { getActiveSituations } from "@/lib/settings/profile-attrs";
import { seedActor } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// A FormData with a label + multiple region[] values (fd() only sets single values).
function injuryForm(
  fields: Record<string, string>,
  regions: string[]
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const r of regions) form.append("regions", r);
  return form;
}

beforeEach(() => revalidate.mockClear());

describe("logInjury (#838)", () => {
  it("logs an active injury with parsed regions and revalidates", async () => {
    const { profile } = seedActor();
    const res = await logInjury(
      injuryForm({ label: "right shoulder", status: "active" }, [
        "Chest",
        "Shoulders",
      ])
    );
    expect(res.ok).toBe(true);

    const rows = getInjuries(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("right shoulder");
    expect(rows[0].status).toBe("active");
    expect(rows[0].regions.sort()).toEqual(["Chest", "Shoulders"]);

    const paths = revalidate.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/training");
    expect(paths).toContain("/timeline");
  });

  it("refuses a log with no affected region", async () => {
    const { profile } = seedActor();
    const res = await logInjury(injuryForm({ label: "vague ache" }, []));
    expect(res.ok).toBe(false);
    expect(getInjuries(profile.id)).toHaveLength(0);
  });

  it("refuses a log with no label", async () => {
    const { profile } = seedActor();
    const res = await logInjury(injuryForm({ label: "  " }, ["Chest"]));
    expect(res.ok).toBe(false);
    expect(getInjuries(profile.id)).toHaveLength(0);
  });
});

describe("setInjuryStatus (#838)", () => {
  it("resolving stamps resolved_date; the record is kept", async () => {
    const { profile } = seedActor();
    await logInjury(injuryForm({ label: "knee" }, ["Legs"]));
    const id = getInjuries(profile.id)[0].id;

    const res = await setInjuryStatus(
      (() => {
        const f = new FormData();
        f.set("id", String(id));
        f.set("status", "resolved");
        return f;
      })()
    );
    expect(res.ok).toBe(true);
    const row = getInjuries(profile.id)[0];
    expect(row.status).toBe("resolved");
    expect(row.resolvedDate).toBeTruthy();
  });

  it("moving back off resolved clears resolved_date", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm({ label: "knee", status: "resolved" }, ["Legs"])
    );
    const id = getInjuries(profile.id)[0].id;
    const f = new FormData();
    f.set("id", String(id));
    f.set("status", "recovering");
    await setInjuryStatus(f);
    const row = getInjuries(profile.id)[0];
    expect(row.status).toBe("recovering");
    expect(row.resolvedDate).toBeNull();
  });
});

describe("updateInjury + deleteInjury (#838)", () => {
  it("edits label/regions in place", async () => {
    const { profile } = seedActor();
    await logInjury(injuryForm({ label: "shoulder" }, ["Chest"]));
    const id = getInjuries(profile.id)[0].id;
    const res = await updateInjury(
      injuryForm(
        { id: String(id), label: "left shoulder", status: "recovering" },
        ["Shoulders"]
      )
    );
    expect(res.ok).toBe(true);
    const row = getInjuries(profile.id)[0];
    expect(row.label).toBe("left shoulder");
    expect(row.status).toBe("recovering");
    expect(row.regions).toEqual(["Shoulders"]);
  });

  it("deletes an injury row (plain profile-scoped delete)", async () => {
    const { profile } = seedActor();
    await logInjury(injuryForm({ label: "wrist" }, ["Arms"]));
    const id = getInjuries(profile.id)[0].id;
    const f = new FormData();
    f.set("id", String(id));
    const res = await deleteInjury(f);
    expect(res.ok).toBe(true);
    expect(getInjuries(profile.id)).toHaveLength(0);
  });

  it("scopes to the acting profile — a foreign id is a no-op", async () => {
    const a = seedActor();
    await logInjury(injuryForm({ label: "hip" }, ["Glutes"]));
    const foreignId = getInjuries(a.profile.id)[0].id;

    // A second actor can't delete the first actor's injury.
    seedActor();
    const f = new FormData();
    f.set("id", String(foreignId));
    const res = await deleteInjury(f);
    expect(res.ok).toBe(false);
    expect(getInjuries(a.profile.id)).toHaveLength(1);
  });
});

describe("activateInjurySituation bridge (#838, suggest-only)", () => {
  it("activates the built-in Injury situation on confirm", async () => {
    const { profile } = seedActor();
    expect(getActiveSituations(profile.id)).not.toContain("Injury");
    const res = await activateInjurySituation();
    expect(res.ok).toBe(true);
    expect(getActiveSituations(profile.id)).toContain("Injury");
  });
});
