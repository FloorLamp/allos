// SERVER-ACTION TIER (issue #550): the coverage-gap registry write paths.
// Drives the real actions against the throwaway DB with the mocked auth boundary
// (setup.ts). Asserts detection surfaces uncatalogued items, opt-in/untrack write
// the profile-scoped registry, the AI-fill path degrades gracefully with no AI, and
// a member can't touch another profile's gaps.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";
import { getCoverageGaps, getCoverageGapCandidates } from "@/lib/queries";
import {
  trackCoverageGap,
  untrackCoverageGap,
  enrichCoverageGapAction,
} from "@/app/(app)/coverage/actions";

// An uncatalogued canonical name — deliberately gibberish so no curated seed / #482
// family covers it. (A real name like "LDL Cholesterol" is covered by the seed.)
const GAP_BIOMARKER = "Obscure Novel Analyte QZX";
const COVERED_BIOMARKER = "LDL Cholesterol";

function addLab(profileId: number, canonical: string) {
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
     VALUES (?, '2026-01-01', 'lab', ?, 5, 'mg/dL', ?)`
  ).run(profileId, canonical, canonical);
}

function addMed(profileId: number, name: string) {
  db.prepare(
    "INSERT INTO intake_items (profile_id, name, active, kind) VALUES (?, ?, 1, 'medication')"
  ).run(profileId, name);
}

describe("coverage-gap actions", () => {
  beforeEach(() => {
    // AI off by default so the enrich path exercises graceful degradation.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_BASE_URL;
  });

  it("detects an uncatalogued biomarker + medication as candidates, not a covered one", () => {
    const { profile } = seedActor();
    addLab(profile.id, GAP_BIOMARKER);
    addLab(profile.id, COVERED_BIOMARKER);
    addMed(profile.id, "Zzzfakedrug QZX");

    const candidates = getCoverageGapCandidates(profile.id);
    const labels = candidates.map((c) => c.label);
    expect(labels).toContain(GAP_BIOMARKER);
    expect(labels).toContain("Zzzfakedrug QZX");
    expect(labels).not.toContain(COVERED_BIOMARKER);
  });

  it("tracks a gap (opt-in) then untracks it", async () => {
    const { profile } = seedActor();
    addLab(profile.id, GAP_BIOMARKER);
    const cand = getCoverageGapCandidates(profile.id)[0];

    await trackCoverageGap(
      fd({ kind: cand.kind, item_key: cand.itemKey, label: cand.label })
    );

    let tracked = getCoverageGaps(profile.id);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].label).toBe(GAP_BIOMARKER);
    expect(tracked[0].covered).toBe(false);

    // Once tracked, it is no longer offered as a candidate (dedup).
    expect(
      getCoverageGapCandidates(profile.id).map((c) => c.label)
    ).not.toContain(GAP_BIOMARKER);

    await untrackCoverageGap(fd({ id: tracked[0].id }));
    tracked = getCoverageGaps(profile.id);
    expect(tracked).toHaveLength(0);
  });

  it("tracking is idempotent (unique kind+item_key)", async () => {
    const { profile } = seedActor();
    addLab(profile.id, GAP_BIOMARKER);
    const cand = getCoverageGapCandidates(profile.id)[0];
    const form = () =>
      fd({ kind: cand.kind, item_key: cand.itemKey, label: cand.label });
    await trackCoverageGap(form());
    await trackCoverageGap(form());
    expect(getCoverageGaps(profile.id)).toHaveLength(1);
  });

  it("the AI-fill path degrades gracefully with no AI configured", async () => {
    const { profile } = seedActor();
    addLab(profile.id, GAP_BIOMARKER);
    const cand = getCoverageGapCandidates(profile.id)[0];
    await trackCoverageGap(
      fd({ kind: cand.kind, item_key: cand.itemKey, label: cand.label })
    );
    const id = getCoverageGaps(profile.id)[0].id;

    const outcome = await enrichCoverageGapAction(fd({ id }));
    expect(outcome.status).toBe("not-configured");
    // Nothing stored — the safety boundary holds even for the descriptive blurb.
    expect(getCoverageGaps(profile.id)[0].aiDescription).toBeNull();
  });

  it("a gap becomes 'covered' once the curated catalog gains the item", async () => {
    // A dedicated name so promoting it to a seed doesn't affect other tests
    // (the temp DB is shared across a file's tests).
    const NAME = "Becomes Covered Analyte QZX";
    const { profile } = seedActor();
    addLab(profile.id, NAME);
    const cand = getCoverageGapCandidates(profile.id).find(
      (c) => c.label === NAME
    )!;
    await trackCoverageGap(
      fd({ kind: cand.kind, item_key: cand.itemKey, label: cand.label })
    );
    const covRow = () =>
      getCoverageGaps(profile.id).find((g) => g.label === NAME)!;
    expect(covRow().covered).toBe(false);

    // Simulate a later catalog update promoting the analyte to a curated seed row.
    db.prepare(
      "INSERT OR IGNORE INTO canonical_biomarkers (name, source) VALUES (?, 'seed')"
    ).run(NAME);

    expect(covRow().covered).toBe(true);
  });

  it("is profile-scoped: one profile's gaps are invisible to another", async () => {
    const admin = createLogin({ role: "admin" });
    const p1 = createProfile("P1");
    const p2 = createProfile("P2");

    actAs(admin, p1);
    addLab(p1.id, GAP_BIOMARKER);
    const cand = getCoverageGapCandidates(p1.id)[0];
    await trackCoverageGap(
      fd({ kind: cand.kind, item_key: cand.itemKey, label: cand.label })
    );
    const p1GapId = getCoverageGaps(p1.id)[0].id;

    // P2 sees none of P1's registry.
    actAs(admin, p2);
    expect(getCoverageGaps(p2.id)).toHaveLength(0);
    // An untrack aimed at P1's row while acting as P2 is a no-op (scoped by profile).
    await untrackCoverageGap(fd({ id: p1GapId }));
    actAs(admin, p1);
    expect(getCoverageGaps(p1.id)).toHaveLength(1);
  });
});
