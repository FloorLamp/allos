// SERVER-ACTION TIER — free-text symptom intake (issue #877).
//
// Drives the real suggestSymptomsFromText action over a CANNED Light-tier response
// (the Anthropic SDK injected at the ai-client seam), then commits the suggestions
// through the EXISTING logSymptom / logTemperature actions and proves the rows land
// IDENTICAL to tapping the same symptoms manually. No network — the model output is a
// fixture, exactly like the extraction runtime tests.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/lib/ai-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-client")>();
  return { ...actual, createAiClient: vi.fn() };
});

import { db } from "@/lib/db";
import { createAiClient } from "@/lib/ai-client";
import {
  suggestSymptomsFromText,
  logSymptom,
  logTemperature,
} from "@/app/(app)/symptoms/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";
import { toolMessage, fakeClient } from "../__db_tests__/ai-fake-client";

const createAiClientMock = vi.mocked(createAiClient);

let savedKey: string | undefined;
beforeAll(() => {
  // A key is present so the Heavy tier (the Light fallback) resolves; the client is
  // mocked, so no real key/network is used.
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function symptomRows(profileId: number) {
  return db
    .prepare(
      "SELECT date, symptom, severity FROM symptom_logs WHERE profile_id = ? ORDER BY symptom"
    )
    .all(profileId) as { date: string; symptom: string; severity: number }[];
}

describe("suggestSymptomsFromText — suggest-only, then confirm via existing actions", () => {
  it("maps a sentence to suggestions and never writes on suggest", async () => {
    const login = createLogin();
    const profile = createProfile("sick-kid", login.id);
    actAs(login, profile);

    createAiClientMock.mockReturnValue(
      fakeClient(
        toolMessage("map_symptoms", {
          symptoms: [
            { slug: "fever", severity: null, note: "since lunch" },
            { slug: "cough", severity: 3 },
          ],
          temperature: { value: 101.2, unit: "F" },
          unmapped: ["croupy"],
          day: "today",
        })
      )
    );

    const res = await suggestSymptomsFromText(
      fd({ text: "fever since lunch, bad cough" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.mapping.symptoms.map((s) => s.slug)).toEqual(["fever", "cough"]);
    expect(res.mapping.symptoms[0].severity).toBe(1); // conservative default
    expect(res.mapping.symptoms[1].severity).toBe(3); // explicit cue honored
    expect(res.mapping.temperature).toEqual({ value: 101.2, unit: "F" });
    expect(res.mapping.unmapped).toEqual(["croupy"]);

    // Suggest-only: NOTHING was written.
    expect(symptomRows(profile.id)).toHaveLength(0);
  });

  it("committing the suggestions lands rows identical to manual taps", async () => {
    const login = createLogin();
    // Two profiles: one confirms from text, one taps manually — assert parity.
    const viaText = createProfile("via-text", login.id);
    const viaTap = createProfile("via-tap", login.id);
    const DATE = "2026-07-10";

    // --- Confirm-from-text path (mirrors the bar's confirmIntake loop) ---
    actAs(login, viaText);
    createAiClientMock.mockReturnValue(
      fakeClient(
        toolMessage("map_symptoms", {
          symptoms: [
            { slug: "fever", severity: 2 },
            { slug: "headache", severity: 4 },
          ],
          temperature: null,
          unmapped: [],
        })
      )
    );
    const res = await suggestSymptomsFromText(
      fd({ text: "feverish, awful headache" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    for (const s of res.mapping.symptoms) {
      await logSymptom(
        fd({ symptom: s.slug, severity: s.severity, date: DATE })
      );
    }

    // --- Manual-tap path ---
    actAs(login, viaTap);
    await logSymptom(fd({ symptom: "fever", severity: 2, date: DATE }));
    await logSymptom(fd({ symptom: "headache", severity: 4, date: DATE }));

    // Parity: same symptoms, same severities, same date.
    const textRows = symptomRows(viaText.id).map((r) => ({
      symptom: r.symptom,
      severity: r.severity,
      date: r.date,
    }));
    const tapRows = symptomRows(viaTap.id).map((r) => ({
      symptom: r.symptom,
      severity: r.severity,
      date: r.date,
    }));
    expect(textRows).toEqual(tapRows);
    expect(textRows).toEqual([
      { symptom: "fever", severity: 2, date: DATE },
      { symptom: "headache", severity: 4, date: DATE },
    ]);
  });

  it("degrades to not-configured when no tier is available", async () => {
    const login = createLogin();
    const profile = createProfile("no-ai", login.id);
    actAs(login, profile);
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    createAiClientMock.mockClear();
    try {
      const res = await suggestSymptomsFromText(
        fd({ text: "fever and cough" })
      );
      expect(res).toEqual({ ok: false, reason: "not-configured" });
      expect(createAiClientMock).not.toHaveBeenCalled();
    } finally {
      process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
