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
import { confirmConditionSuggestion } from "@/app/(app)/conditions/actions";
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
