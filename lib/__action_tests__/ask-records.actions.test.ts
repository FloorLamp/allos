// SERVER-ACTION TIER — the grounded record Q&A action (issue #878, Phase 2).
//
// Drives the real askRecordsAction through the (mocked) auth guard end-to-end: the
// deterministic retrieval gathers the ACTIVE profile's own rows, then the answer is
// narrated (mocked Light client) or falls back to the offline structured answer
// (keyless — the surface CI exercises). Pins the load-bearing seams: the answer carries
// row-link CITATIONS, an empty retrieval is a hard "nothing found" refusal that never
// calls the model, and another profile's rows never reach the citations (active-profile-
// only scope). Synthetic values only (no PHI).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/lib/ai-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-client")>();
  return { ...actual, createAiClient: vi.fn() };
});

import { createAiClient } from "@/lib/ai-client";
import { askRecordsAction } from "@/app/(app)/search-actions";
import { createLogin, createProfile, actAs } from "./harness";
import { noToolMessage, fakeClient } from "../__db_tests__/ai-fake-client";
import { db } from "@/lib/db";

const createAiClientMock = vi.mocked(createAiClient);

function askFd(question: string) {
  const fd = new FormData();
  fd.set("question", question);
  return fd;
}

// A profile with an antibiotics medication (findable from the question terms), and a
// SECOND profile whose antibiotics med must never leak into the first's answer.
function seedTwoProfiles() {
  const login = createLogin();
  const mine = createProfile("QA mine", login.id);
  const other = createProfile("QA other", login.id);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, active, notes)
     VALUES (?, 'Amoxicillin', 'medication', 1, 'Antibiotics course for a sinus infection')`
  ).run(mine.id);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, active, notes)
     VALUES (?, 'Cephalexin', 'medication', 1, 'Antibiotics for a skin infection')`
  ).run(other.id);
  return { login, mine, other };
}

describe("askRecordsAction — keyless (offline, grounded rows still linked)", () => {
  it("answers over the retrieved rows with citations and never calls the model", async () => {
    const { login, mine } = seedTwoProfiles();
    actAs(login, mine);
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    createAiClientMock.mockClear();
    try {
      const res = await askRecordsAction(
        askFd("when did I last take antibiotics?")
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.offline).toBe(true);
      expect(res.citations.map((c) => c.title)).toContain("Amoxicillin");
      // Every citation carries a real link.
      expect(res.citations.every((c) => c.href)).toBe(true);
      // Degradation never calls the model.
      expect(createAiClientMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("refuses an unmatched question with 'nothing found' and no model call", async () => {
    const { login, mine } = seedTwoProfiles();
    actAs(login, mine);
    createAiClientMock.mockClear();
    const res = await askRecordsAction(
      askFd("chemotherapy radiation dialysis?")
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.answer).toBe("Nothing found in your records.");
    expect(res.citations).toHaveLength(0);
    expect(createAiClientMock).not.toHaveBeenCalled();
  });

  it("never leaks another profile's rows into the active profile's answer", async () => {
    const { login, mine } = seedTwoProfiles();
    actAs(login, mine);
    const res = await askRecordsAction(askFd("antibiotics?"));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.citations.map((c) => c.title)).not.toContain("Cephalexin");
  });

  it("rejects an empty question", async () => {
    const { login, mine } = seedTwoProfiles();
    actAs(login, mine);
    const res = await askRecordsAction(askFd("   "));
    expect(res.ok).toBe(false);
  });
});

describe("askRecordsAction — with a Light tier configured (narration)", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it("returns the model's grounded narration with the citations", async () => {
    const { login, mine } = seedTwoProfiles();
    actAs(login, mine);
    createAiClientMock.mockReturnValue(
      fakeClient(noToolMessage("You last took Amoxicillin on 2026-03-04 [1]."))
    );
    const res = await askRecordsAction(
      askFd("when did I last take antibiotics?")
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.offline).toBe(false);
    expect(res.answer).toContain("Amoxicillin");
    expect(res.citations.map((c) => c.title)).toContain("Amoxicillin");
  });

  it("still refuses an empty retrieval WITHOUT calling the model", async () => {
    const { login, mine } = seedTwoProfiles();
    actAs(login, mine);
    createAiClientMock.mockClear();
    const res = await askRecordsAction(
      askFd("chemotherapy radiation dialysis?")
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.answer).toBe("Nothing found in your records.");
    expect(createAiClientMock).not.toHaveBeenCalled();
  });
});
