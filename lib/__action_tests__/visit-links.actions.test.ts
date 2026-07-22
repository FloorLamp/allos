// SERVER-ACTION TIER (#1050/#1053) — the visit-link accept/decline/manual-link write
// paths, driven through the real actions with the auth boundary mocked (setup.ts).
// The pure/DB tiers can't see the auth gate or the FormData plumbing; this is the
// dynamic guard that the actions set encounter_id, remember a decline, and NULL the
// links on encounter delete.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  linkRecordVisitAction,
  declineRecordVisitAction,
  linkAllFromVisitAction,
  unlinkRecordVisitAction,
  linkEpisodeVisitAction,
  declineEpisodeVisitAction,
  unlinkEpisodeVisitAction,
} from "@/app/(app)/visit-links/actions";
import { encountersForEpisode } from "@/lib/queries";
import { deleteEncounter } from "@/app/(app)/encounters/actions";
import { seedActor, fd } from "./harness";

function episodeVisitIds(profileId: number, episodeId: number): number[] {
  return encountersForEpisode(profileId, episodeId).map((e) => e.id);
}

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function newEncounter(profileId: number, date = "2026-03-03"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type) VALUES (?, ?, 'Office Visit')`
      )
      .run(profileId, date).lastInsertRowid
  );
}
function newMedication(profileId: number, name = "Amoxicillin"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind) VALUES (?, ?, 'medication')`
      )
      .run(profileId, name).lastInsertRowid
  );
}
function medEncounterId(id: number): number | null {
  return (
    db
      .prepare(`SELECT encounter_id FROM intake_items WHERE id = ?`)
      .get(id) as {
      encounter_id: number | null;
    }
  ).encounter_id;
}

describe("record ↔ visit actions", () => {
  it("linkRecordVisitAction sets encounter_id", async () => {
    const { profile } = seedActor();
    const enc = newEncounter(profile.id);
    const med = newMedication(profile.id);
    await linkRecordVisitAction(
      fd({ domain: "medication", recordId: med, encounterId: enc })
    );
    expect(medEncounterId(med)).toBe(enc);
    expect(revalidate).toHaveBeenCalled();
  });

  it("declineRecordVisitAction remembers the decline (no link set)", async () => {
    const { profile } = seedActor();
    const enc = newEncounter(profile.id);
    const med = newMedication(profile.id);
    await declineRecordVisitAction(
      fd({ domain: "medication", recordId: med, encounterId: enc })
    );
    expect(medEncounterId(med)).toBeNull();
    const decision = db
      .prepare(
        `SELECT decision FROM visit_link_decisions WHERE profile_id = ? AND domain = 'medication'`
      )
      .get(profile.id) as { decision: string } | undefined;
    expect(decision?.decision).toBe("declined");
  });

  it("linkAllFromVisitAction links a batch, unlink clears one", async () => {
    const { profile } = seedActor();
    const enc = newEncounter(profile.id);
    const m1 = newMedication(profile.id, "Amox");
    const m2 = newMedication(profile.id, "Ibup");
    await linkAllFromVisitAction(
      fd({
        encounterId: enc,
        pairs: JSON.stringify([
          { domain: "medication", recordId: m1 },
          { domain: "medication", recordId: m2 },
        ]),
      })
    );
    expect(medEncounterId(m1)).toBe(enc);
    expect(medEncounterId(m2)).toBe(enc);

    await unlinkRecordVisitAction(fd({ domain: "medication", recordId: m1 }));
    expect(medEncounterId(m1)).toBeNull();
    expect(medEncounterId(m2)).toBe(enc);
  });

  it("deleteEncounter NULLs the record + episode links", async () => {
    const { profile } = seedActor();
    const enc = newEncounter(profile.id);
    const med = newMedication(profile.id);
    await linkRecordVisitAction(
      fd({ domain: "medication", recordId: med, encounterId: enc })
    );
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at)
           VALUES (?, 'cold', '2026-03-01')`
        )
        .run(profile.id).lastInsertRowid
    );
    await linkEpisodeVisitAction(fd({ episodeId, encounterId: enc }));
    await deleteEncounter(fd({ id: enc }));
    expect(medEncounterId(med)).toBeNull();
    expect(episodeVisitIds(profile.id, episodeId)).toEqual([]);
  });
});

describe("episode ↔ visit actions", () => {
  it("linkEpisodeVisitAction sets the link; decline remembers it", async () => {
    const { profile } = seedActor();
    const enc = newEncounter(profile.id, "2026-03-04");
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'flu', '2026-03-01', '2026-03-08')`
        )
        .run(profile.id).lastInsertRowid
    );
    await linkEpisodeVisitAction(fd({ episodeId, encounterId: enc }));
    expect(episodeVisitIds(profile.id, episodeId)).toEqual([enc]);

    const enc2 = newEncounter(profile.id, "2026-03-05");
    await declineEpisodeVisitAction(fd({ episodeId, encounterId: enc2 }));
    const declined = db
      .prepare(
        `SELECT COUNT(*) AS n FROM visit_link_decisions
          WHERE profile_id = ? AND domain = 'episode' AND decision = 'declined'`
      )
      .get(profile.id) as { n: number };
    expect(declined.n).toBe(1);
  });

  it("linkEpisodeVisitAction twice ADDS (never overwrites); per-visit unlink clears only that link + its decision (#1198)", async () => {
    const { profile } = seedActor();
    const a = newEncounter(profile.id, "2026-03-04");
    const b = newEncounter(profile.id, "2026-03-06");
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'flu', '2026-03-01', '2026-03-10')`
        )
        .run(profile.id).lastInsertRowid
    );
    await linkEpisodeVisitAction(fd({ episodeId, encounterId: a }));
    await linkEpisodeVisitAction(fd({ episodeId, encounterId: b }));
    // Both linked — the second did NOT overwrite the first (the old 1:1 bug).
    expect(episodeVisitIds(profile.id, episodeId).sort()).toEqual(
      [a, b].sort()
    );
    // Two 'linked' decisions, one per encounter.
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM visit_link_decisions
              WHERE profile_id = ? AND domain = 'episode' AND decision = 'linked'`
          )
          .get(profile.id) as { n: number }
      ).n
    ).toBe(2);
    // Unlink one → the other survives, and only its decision is cleared.
    await unlinkEpisodeVisitAction(fd({ episodeId, encounterId: a }));
    expect(episodeVisitIds(profile.id, episodeId)).toEqual([b]);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM visit_link_decisions
              WHERE profile_id = ? AND domain = 'episode' AND decision = 'linked'`
          )
          .get(profile.id) as { n: number }
      ).n
    ).toBe(1);
  });
});
