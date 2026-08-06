// SERVER-ACTION TIER — condition-suggestion confirm path (issue #685).
//
// confirmConditionSuggestion is the suggest→confirm write core's action boundary: it
// gates on requireWriteAccess, then creates a problem-list Condition from a suggested
// name/code via the auth-blind addSuggestedConditionCore. Pins: the insert lands with
// source='result'; a re-confirm is idempotent (external_id keyed); an empty name is
// refused; and the write revalidates the conditions + upcoming paths.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  confirmConditionSuggestion,
  updateCondition,
} from "@/app/(app)/records/problems/conditions/actions";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function conditionRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, name, code, status, source, external_id FROM conditions WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as {
    id: number;
    name: string;
    code: string | null;
    status: string;
    source: string | null;
    external_id: string | null;
  }[];
}

beforeEach(() => revalidate.mockClear());

describe("confirmConditionSuggestion (#685)", () => {
  it("creates the suggested condition with source='result' and revalidates", async () => {
    const { profile } = seedActor();
    const res = await confirmConditionSuggestion(fd({ name: "Hepatitis C" }));
    expect(res.ok).toBe(true);

    const rows = conditionRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Hepatitis C");
    expect(rows[0].status).toBe("active");
    expect(rows[0].source).toBe("result");
    expect(rows[0].external_id).toBe("condition-suggest:name:hepatitis c");

    const paths = revalidate.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/records");
    expect(paths).toContain("/upcoming");
  });

  it("is idempotent — re-confirming the same concept adds no duplicate", async () => {
    const { profile } = seedActor();
    await confirmConditionSuggestion(fd({ name: "HIV" }));
    await confirmConditionSuggestion(fd({ name: "HIV" }));
    expect(conditionRows(profile.id)).toHaveLength(1);
  });

  it("refuses an empty suggestion name", async () => {
    const { profile } = seedActor();
    const res = await confirmConditionSuggestion(fd({ name: "  " }));
    expect(res.ok).toBe(false);
    expect(conditionRows(profile.id)).toHaveLength(0);
  });
});

describe("updateCondition stamps the edit lock (#2137)", () => {
  it("a manual save sets edited = 1, so an episode-promoted row locks against its sync", async () => {
    const { profile } = seedActor();
    // An episode-promoted condition, as promoteEpisodeToConditionCore writes it.
    const id = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, onset_date, resolved_date, source, external_id)
           VALUES (?, 'Illness', 'resolved', '2026-06-01', '2026-06-05',
                   'episode', 'illness-episode:1')`
        )
        .run(profile.id).lastInsertRowid
    );
    const before = db
      .prepare("SELECT edited FROM conditions WHERE id = ?")
      .get(id) as { edited: number };
    expect(before.edited).toBe(0);

    const res = await updateCondition(
      fd({ id, name: "Chronic sinusitis", status: "inactive" })
    );
    expect(res.ok).toBe(true);
    const after = db
      .prepare("SELECT name, status, edited FROM conditions WHERE id = ?")
      .get(id) as { name: string; status: string; edited: number };
    expect(after).toEqual({
      name: "Chronic sinusitis",
      status: "inactive",
      edited: 1,
    });
  });
});
