// SERVER-ACTION TIER — pins the delete-time pair-decision policy (issue #334).
//
// A plain deleteActivity DELIBERATELY leaves any recorded import-pair decision the
// deleted row took part in in place (`import_pair_decisions`, keyed on the stable
// pair signature). This is the pair-decision durability contract: a sourced row is
// re-created by the rolling re-sync under the same external_id and re-forms the
// identical pair, where the prior resolution should still apply; a manual row's
// `id:` token never recycles, so its leftover is a harmless dead row. A bare delete
// is not an "un-resolve" — only a MERGE's undo clears its own decision (#200). If
// this policy is ever changed (e.g. to clear `ext:` signatures on delete), this test
// is the pin that must be updated alongside the code + the comment at the site.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { deleteActivity } from "@/app/(app)/journal/actions";
import { undoDelete } from "@/app/(app)/undo/actions";
import { getPairDecisions, recordPairDecision } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  activityToken,
  pairSignature,
} from "@/lib/import-review/detect";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// Insert an activity; returns its id. A sourced row carries source + external_id (so
// its stable token is `ext:<external_id>`); a manual row leaves them null (`id:<id>`).
function insertActivity(
  profileId: number,
  over: Partial<{
    date: string;
    title: string;
    source: string | null;
    external_id: string | null;
  }> = {}
): number {
  const row = {
    date: "2026-05-01",
    title: "Run",
    source: null as string | null,
    external_id: null as string | null,
    ...over,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source, external_id)
         VALUES (?, ?, 'cardio', ?, ?, ?)`
      )
      .run(profileId, row.date, row.title, row.source, row.external_id)
      .lastInsertRowid
  );
}

const activityRow = (id: number) =>
  db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;

// The stable pair signature for two activity ids (re-reading each row's tokens).
function signatureFor(idA: number, idB: number): string {
  const a = activityRow(idA)! as { id: number; external_id: string | null };
  const b = activityRow(idB)! as { id: number; external_id: string | null };
  return pairSignature(activityToken(a), activityToken(b));
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("deleteActivity — pair-decision policy (#334)", () => {
  it("leaves a decision keyed on the deleted SOURCED row's ext: token in place", async () => {
    const login = createLogin();
    const profile = createProfile("del-sourced", login.id);
    actAs(login, profile);

    const manualId = insertActivity(profile.id, { title: "Manual run" });
    const stravaId = insertActivity(profile.id, {
      title: "GPS run",
      source: "strava",
      external_id: "strava:99",
    });
    // The pair was resolved "kept-both" in Review, keyed on the stable signature.
    const sig = signatureFor(manualId, stravaId);
    recordPairDecision(profile.id, ACTIVITY_DOMAIN, sig, "kept-both");

    const { undoId } = await deleteActivity(fd({ id: stravaId }));
    expect(undoId).not.toBeNull();
    expect(activityRow(stravaId)).toBeUndefined(); // row gone

    // The decision SURVIVES: it re-applies when strava:99 re-syncs into the same pair.
    const decisions = getPairDecisions(profile.id, ACTIVITY_DOMAIN);
    expect(decisions.get(sig)).toBe("kept-both");
  });

  it("leaves a decision keyed on a deleted MANUAL row's id: token in place (dead-but-harmless)", async () => {
    const login = createLogin();
    const profile = createProfile("del-manual", login.id);
    actAs(login, profile);

    const manualId = insertActivity(profile.id, { title: "Manual run" });
    const stravaId = insertActivity(profile.id, {
      title: "GPS run",
      source: "strava",
      external_id: "strava:1",
    });
    const sig = signatureFor(manualId, stravaId);
    recordPairDecision(profile.id, ACTIVITY_DOMAIN, sig, "dismissed");

    await deleteActivity(fd({ id: manualId }));
    expect(activityRow(manualId)).toBeUndefined();

    // The id:<manualId> token never recycles, so the leftover is harmless — and the
    // policy keeps it (no special-casing of the manual side either).
    expect(getPairDecisions(profile.id, ACTIVITY_DOMAIN).get(sig)).toBe(
      "dismissed"
    );
  });

  it("undo restores the row and the decision was never touched", async () => {
    const login = createLogin();
    const profile = createProfile("del-undo", login.id);
    actAs(login, profile);

    const manualId = insertActivity(profile.id, { title: "Manual run" });
    const stravaId = insertActivity(profile.id, {
      title: "GPS run",
      source: "strava",
      external_id: "strava:7",
    });
    const sig = signatureFor(manualId, stravaId);
    recordPairDecision(profile.id, ACTIVITY_DOMAIN, sig, "merged");

    const { undoId } = await deleteActivity(fd({ id: stravaId }));
    expect(getPairDecisions(profile.id, ACTIVITY_DOMAIN).get(sig)).toBe(
      "merged"
    );

    const { ok } = await undoDelete(undoId!);
    expect(ok).toBe(true);
    // Row is back (new id, same title) and the decision is still exactly as recorded.
    const restored = db
      .prepare(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND title = 'GPS run'"
      )
      .get(profile.id) as { c: number };
    expect(restored.c).toBe(1);
    expect(getPairDecisions(profile.id, ACTIVITY_DOMAIN).get(sig)).toBe(
      "merged"
    );
  });
});
