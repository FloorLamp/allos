// SERVER-ACTION TIER (#1050/#1053) — the visit-link accept/decline/manual-link write
// paths, driven through the real actions with the auth boundary mocked (setup.ts).
// The pure/DB tiers can't see the auth gate or the FormData plumbing; this is the
// dynamic guard that the actions set encounter_id, remember a decline, NULL the
// links on encounter delete, and — for all ten at once, at the bottom of this file —
// file the write against the profile the form posted rather than the acting one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  linkRecordVisitAction,
  declineRecordVisitAction,
  linkAllFromVisitAction,
  dismissAllFromVisitAction,
  createVisitFromRecordAction,
  declineCreateVisitAction,
  unlinkRecordVisitAction,
  linkEpisodeVisitAction,
  declineEpisodeVisitAction,
  unlinkEpisodeVisitAction,
} from "@/app/(app)/visit-link-actions";
import { encountersForEpisode } from "@/lib/queries";
import { deleteEncounter } from "@/app/(app)/encounters/actions";
import { seedActor, createProfile, fd } from "./harness";

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
          `INSERT INTO illness_episodes (profile_id, situation, start_date)
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
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (?, 'flu', '2026-03-01', '2026-03-07')`
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
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (?, 'flu', '2026-03-01', '2026-03-09')`
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

// ── THE SUBJECT IS SPELLED ONCE, FOR ALL TEN (#4780) ─────────────────────────
//
// Each of these ten actions hand-rolled `gateItemProfile`'s two branches around a
// camelCase `profileId` — the divergence #4730 closed in `logFoodServing`, and the
// same silent failure: the gate resolves the ACTING profile, the write is filed
// against the wrong person, and the row that results is a perfectly ordinary row.
//
// The tests above all act AS the subject, which is exactly the arrangement that
// cannot see this: a gate that fell back to the actor would still look correct. So
// every case below acts as a caregiver and posts a DIFFERENT, write-granted subject,
// and reads the STORE rather than any return value — these actions return void, so
// the rows are the only witness.
//
// `visitLinkState` is every table the ten cores write, for one profile. Comparing it
// before and after is what lets one table ask all ten the same two questions without
// ten bespoke assertions: the subject's state must MOVE and the actor's must NOT.
// A second spelling reappearing between a form and the gate inverts that pair — the
// action resolves the caregiver, every core then refuses the subject's rows as not
// its own, and the subject's state sits still.

const VISIT_LINK_TABLES = [
  "encounters",
  "intake_items",
  "optical_prescriptions",
  "visit_link_decisions",
  "episode_encounters",
] as const;

function visitLinkState(profileId: number): string {
  return VISIT_LINK_TABLES.map((t) =>
    JSON.stringify(
      db
        .prepare(`SELECT * FROM ${t} WHERE profile_id = ? ORDER BY id`)
        .all(profileId)
    )
  ).join("|");
}

function newOpticalRx(profileId: number, date = "2026-04-04"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO optical_prescriptions (profile_id, kind, issued_date)
         VALUES (?, 'glasses', ?)`
      )
      .run(profileId, date).lastInsertRowid
  );
}
function newEpisode(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, 'flu', '2026-03-01', '2026-03-09')`
      )
      .run(profileId).lastInsertRowid
  );
}

// Every visit-link action, with a payload that WOULD write if the gate let it — the
// positive control the refusal cases need, since an action given nothing to act on
// refuses and writes nothing for the wrong reason.
const SUBJECT_GATED: {
  name: string;
  action: (formData: FormData) => Promise<void>;
  payload: (profileId: number) => Record<string, string | number>;
}[] = [
  {
    name: "linkRecordVisitAction",
    action: linkRecordVisitAction,
    payload: (p) => ({
      domain: "medication",
      recordId: newMedication(p),
      encounterId: newEncounter(p),
    }),
  },
  {
    name: "declineRecordVisitAction",
    action: declineRecordVisitAction,
    payload: (p) => ({
      domain: "medication",
      recordId: newMedication(p),
      encounterId: newEncounter(p),
    }),
  },
  {
    name: "linkAllFromVisitAction",
    action: linkAllFromVisitAction,
    payload: (p) => ({
      encounterId: newEncounter(p),
      pairs: JSON.stringify([
        { domain: "medication", recordId: newMedication(p) },
      ]),
    }),
  },
  {
    name: "dismissAllFromVisitAction",
    action: dismissAllFromVisitAction,
    payload: (p) => ({
      encounterId: newEncounter(p),
      pairs: JSON.stringify([
        { domain: "medication", recordId: newMedication(p) },
      ]),
    }),
  },
  {
    name: "unlinkRecordVisitAction",
    action: unlinkRecordVisitAction,
    payload: (p) => {
      const med = newMedication(p);
      db.prepare("UPDATE intake_items SET encounter_id = ? WHERE id = ?").run(
        newEncounter(p),
        med
      );
      return { domain: "medication", recordId: med };
    },
  },
  {
    name: "createVisitFromRecordAction",
    action: createVisitFromRecordAction,
    payload: (p) => ({ domain: "optical", recordId: newOpticalRx(p) }),
  },
  {
    name: "declineCreateVisitAction",
    action: declineCreateVisitAction,
    payload: (p) => ({ domain: "optical", recordId: newOpticalRx(p) }),
  },
  {
    name: "linkEpisodeVisitAction",
    action: linkEpisodeVisitAction,
    payload: (p) => ({
      episodeId: newEpisode(p),
      encounterId: newEncounter(p),
    }),
  },
  {
    name: "declineEpisodeVisitAction",
    action: declineEpisodeVisitAction,
    payload: (p) => ({
      episodeId: newEpisode(p),
      encounterId: newEncounter(p),
    }),
  },
  {
    name: "unlinkEpisodeVisitAction",
    action: unlinkEpisodeVisitAction,
    payload: (p) => {
      const episodeId = newEpisode(p);
      const encounterId = newEncounter(p);
      db.prepare(
        `INSERT INTO episode_encounters (profile_id, episode_id, encounter_id)
         VALUES (?, ?, ?)`
      ).run(p, episodeId, encounterId);
      return { episodeId, encounterId };
    },
  },
];

describe.each(SUBJECT_GATED)(
  "$name — the posted subject",
  ({ action, payload }) => {
    it("writes to the write-granted subject, never to the acting profile", async () => {
      const { login, profile: caregiver } = seedActor({ role: "member" });
      const subject = createProfile("visit-link subject", login.id);
      // The fixture reaches the state the verdict is about before any verdict is read.
      expect(subject.id).not.toBe(caregiver.id);
      const fields = payload(subject.id);
      const subjectBefore = visitLinkState(subject.id);
      const caregiverBefore = visitLinkState(caregiver.id);

      await action(fd({ profile_id: subject.id, ...fields }));

      expect(visitLinkState(subject.id)).not.toBe(subjectBefore);
      expect(visitLinkState(caregiver.id)).toBe(caregiverBefore);
    });

    it.each([
      ["read-only-granted", /read-only/],
      ["ungranted", /not accessible/],
    ] as const)(
      "refuses a %s subject and writes nothing",
      async (grant, refusal) => {
        const { login, profile: caregiver } = seedActor({ role: "member" });
        const subject = createProfile(
          "unwritable visit-link subject",
          grant === "ungranted" ? undefined : login.id
        );
        if (grant === "read-only-granted") {
          db.prepare(
            "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
          ).run(login.id, subject.id);
        }
        const fields = payload(subject.id);
        const subjectBefore = visitLinkState(subject.id);
        const caregiverBefore = visitLinkState(caregiver.id);

        await expect(
          action(fd({ profile_id: subject.id, ...fields }))
        ).rejects.toThrow(refusal);

        // Refused, not quietly re-aimed at the actor — the failure the fallback made.
        expect(visitLinkState(subject.id)).toBe(subjectBefore);
        expect(visitLinkState(caregiver.id)).toBe(caregiverBefore);
      }
    );
  }
);
