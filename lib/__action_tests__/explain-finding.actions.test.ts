// SERVER-ACTION TIER — the finding explainer action (issue #878, Phase 1).
//
// Drives the real explainFindingAction through the (mocked) auth guard: keyless it
// returns the deterministic structured fallback (the graceful-degradation surface CI
// exercises), and with a mocked Light-tier client it returns the model's narration —
// both over the item's OWN reason payload, never a re-derived fact.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/lib/ai-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-client")>();
  return { ...actual, createAiClient: vi.fn() };
});

import { createAiClient } from "@/lib/ai-client";
import { explainFindingAction } from "@/app/(app)/upcoming/actions";
import { createLogin, createProfile, actAs } from "./harness";
import { noToolMessage, fakeClient } from "../__db_tests__/ai-fake-client";

const createAiClientMock = vi.mocked(createAiClient);

function explainFd(reasons: unknown) {
  const fd = new FormData();
  fd.set("title", "LDL Cholesterol");
  fd.set("detail", "130 mg/dL — Below optimal");
  fd.set("reasons", JSON.stringify(reasons));
  return fd;
}

const REASONS = [
  { code: "biomarker-flagged", text: "Below optimal" },
  {
    code: "risk-elevated",
    text: "Family history raises LDL concern",
    source: "ACC/AHA 2018 guideline",
  },
];

describe("explainFindingAction — keyless (offline structured fallback)", () => {
  it("returns the structured reasons verbatim when no tier is configured", async () => {
    const login = createLogin();
    const profile = createProfile("p", login.id);
    actAs(login, profile);
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    createAiClientMock.mockClear();
    try {
      const res = await explainFindingAction(explainFd(REASONS));
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.offline).toBe(true);
      expect(res.text).toContain("LDL Cholesterol is flagged because:");
      expect(res.text).toContain("Below optimal");
      expect(res.text).toContain("Source: ACC/AHA 2018 guideline");
      // Degradation never calls the model.
      expect(createAiClientMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("explainFindingAction — configured (model narration)", () => {
  let savedKey: string | undefined;
  beforeAll(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("returns the model's narration over the reason payload", async () => {
    const login = createLogin();
    const profile = createProfile("p2", login.id);
    actAs(login, profile);
    createAiClientMock.mockReturnValue(
      fakeClient(
        noToolMessage(
          "Your LDL is flagged because it's below the optimal band, and your family history raises the concern."
        )
      )
    );
    const res = await explainFindingAction(explainFd(REASONS));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.offline).toBe(false);
    expect(res.text).toContain("below the optimal band");
  });

  it("drops an unknown reason code before it can reach the prompt", async () => {
    const login = createLogin();
    const profile = createProfile("p3", login.id);
    actAs(login, profile);
    // Even with a junk code echoed in, the action must not fail — the sanitizer keeps
    // only closed-union codes; the model call still runs over the valid remainder.
    createAiClientMock.mockReturnValue(noToolClient());
    const res = await explainFindingAction(
      explainFd([
        { code: "totally-made-up", text: "should be dropped" },
        { code: "biomarker-flagged", text: "Below optimal" },
      ])
    );
    expect(res.ok).toBe(true);
  });
});

function noToolClient() {
  return fakeClient(noToolMessage("Because it's below optimal."));
}
