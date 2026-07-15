// DB INTEGRATION TIER (npm run test:db) — issue #675.
//
// The supplement-suggestion RUNTIME (lib/supplement-suggest.ts) driven end to end
// over CANNED model output, with the Anthropic SDK injected at the `lib/ai-client.ts`
// seam (createAiClient mocked). This exercises the gather → model → deterministic
// SAFETY belt → provenance insert path that the pure tier can't see: the belt's
// facts come from a live profile-scoped gather (allergies/meds/conditions), so the
// drop decision and the persisted rows only exist against a real DB.
//
// Covers ask (5): gather → mocked draft → a belt-violating draft is DROPPED (a fish
// oil suggestion against a recorded fish allergy) while a safe draft SURVIVES and is
// inserted with its provenance columns (trigger / model / rationale); a hallucinated
// "mandatory" with no cited low lab is downgraded to "high"; and at the daily insight
// cap the runtime returns the degraded note and inserts nothing.

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

vi.mock("@/lib/ai-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-client")>();
  return { ...actual, createAiClient: vi.fn() };
});

import { db, today } from "@/lib/db";
import { seedActor } from "@/lib/__action_tests__/harness";
import { AI_MODEL, createAiClient } from "@/lib/ai-client";
import { generateAndStoreSuggestions } from "@/lib/supplement-suggest";
import { insightDailyLimit } from "@/lib/ai-usage";
import { toolMessage, fakeClient } from "./ai-fake-client";

const createAiClientMock = vi.mocked(createAiClient);

interface DraftIn {
  name: string;
  rationale: string;
  condition?: string;
  priority?: string;
  dosage?: string | null;
  time_of_day?: string | null;
}

function suggestInput(drafts: DraftIn[]) {
  return {
    suggestions: drafts.map((d) => ({
      name: d.name,
      dosage: d.dosage ?? null,
      time_of_day: d.time_of_day ?? null,
      food_timing: null,
      condition: d.condition ?? "daily",
      situation: null,
      priority: d.priority ?? "high",
      brand: null,
      product: null,
      rationale: d.rationale,
    })),
  };
}

function suggestionRows(profileId: number) {
  return db
    .prepare(
      "SELECT name, priority, rationale, trigger, source_detail, model, status FROM intake_item_suggestions WHERE profile_id = ? ORDER BY name"
    )
    .all(profileId) as {
    name: string;
    priority: string;
    rationale: string;
    trigger: string;
    source_detail: string | null;
    model: string;
    status: string;
  }[];
}

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

beforeEach(() => {
  createAiClientMock.mockReset();
});

describe("supplement-suggest runtime (issue #675)", () => {
  it("drops a belt-violating draft and inserts the safe one with provenance", async () => {
    const { profile } = seedActor();
    // A recorded fish allergy — the deterministic belt must drop any fish-oil
    // suggestion regardless of what the model proposed.
    db.prepare(
      "INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'Fish', 'active')"
    ).run(profile.id);

    createAiClientMock.mockReturnValue(
      fakeClient(
        toolMessage(
          "suggest_supplements",
          suggestInput([
            {
              name: "Fish Oil",
              rationale: "Omega-3 for cardiovascular support",
            },
            { name: "Vitamin D3", rationale: "Supports bone health" },
          ])
        )
      )
    );

    const res = await generateAndStoreSuggestions(profile.id);

    // Only the safe draft was persisted; the fish oil was screened out.
    expect(res.inserted).toBe(1);
    const rows = suggestionRows(profile.id);
    expect(rows.map((r) => r.name)).toEqual(["Vitamin D3"]);
    // Provenance columns are filled from the run.
    const row = rows[0];
    expect(row.rationale).toBe("Supports bone health");
    expect(row.trigger).toBe("labs");
    expect(row.model).toBe(AI_MODEL);
    expect(row.status).toBe("pending");
  });

  it("downgrades a hallucinated 'mandatory' (no cited low lab) to 'high'", async () => {
    const { profile } = seedActor();
    createAiClientMock.mockReturnValue(
      fakeClient(
        toolMessage(
          "suggest_supplements",
          suggestInput([
            {
              name: "Magnesium",
              rationale: "General wellness — not tied to any lab value",
              priority: "mandatory",
            },
          ])
        )
      )
    );

    const res = await generateAndStoreSuggestions(profile.id);

    expect(res.inserted).toBe(1);
    const rows = suggestionRows(profile.id);
    expect(rows[0].name).toBe("Magnesium");
    // No out-of-range-low lab was cited, so the belt downgrades mandatory → high.
    expect(rows[0].priority).toBe("high");
  });

  it("returns the degraded note and inserts nothing at the daily insight cap", async () => {
    const { profile } = seedActor();
    // Exhaust the shared insight/suggestion daily quota.
    db.prepare(
      `INSERT INTO ai_usage_counters (profile_id, day, kind, count) VALUES (?, ?, 'insight', ?)`
    ).run(profile.id, today(profile.id), insightDailyLimit());

    createAiClientMock.mockReturnValue(
      fakeClient(
        toolMessage(
          "suggest_supplements",
          suggestInput([{ name: "Vitamin D3", rationale: "Bone health" }])
        )
      )
    );

    const res = await generateAndStoreSuggestions(profile.id);

    expect(res.inserted).toBe(0);
    expect(res.note ?? "").toMatch(/daily ai limit/i);
    expect(suggestionRows(profile.id)).toHaveLength(0);
    // The cap refusal never constructs/calls the model.
    expect(createAiClientMock).not.toHaveBeenCalled();
  });
});
