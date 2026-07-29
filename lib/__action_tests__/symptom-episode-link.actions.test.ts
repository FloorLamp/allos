// SERVER-ACTION TIER — the #1093 symptom↔episode link write path.
//
// Proves the real logSymptom / setSymptomEpisode actions run through the (mocked) auth
// guard and enforce: a symptom logged while an episode is open auto-associates under
// requireWriteAccess + profile scoping; explicit detach nulls the link; a cross-profile
// episode id is rejected; and a cross-profile target attach is gated by
// requireProfileWriteAccess (a member without a grant is refused).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { logSymptom, setSymptomEpisode } from "@/app/(app)/symptom-actions";
import { getEpisodeSymptomLogs } from "@/lib/queries";
import { createEpisodeRow } from "@/lib/illness-episode-store";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-03-04";

function episodeIdOf(profileId: number, symptom: string): number | null {
  return (
    db
      .prepare(
        `SELECT episode_id FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .get(profileId, DATE, symptom) as { episode_id: number | null }
  ).episode_id;
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("logSymptom — auto-associates to the open episode (#1093)", () => {
  it("associates a symptom logged during an open episode", async () => {
    const login = createLogin();
    const profile = createProfile("Sick Actor", login.id);
    actAs(login, profile);
    const epId = createEpisodeRow(profile.id, "Illness", "2026-03-03", null);

    const res = await logSymptom(
      fd({ symptom: "cough", severity: 3, date: DATE })
    );
    expect(res.ok).toBe(true);
    expect(episodeIdOf(profile.id, "cough")).toBe(epId);
    expect(
      getEpisodeSymptomLogs(profile.id, epId).map((s) => s.symptom)
    ).toEqual(["cough"]);
  });

  it("leaves a standalone symptom (no open episode) unlinked", async () => {
    const login = createLogin();
    const profile = createProfile("Well Actor", login.id);
    actAs(login, profile);

    const res = await logSymptom(
      fd({ symptom: "headache", severity: 2, date: DATE })
    );
    expect(res.ok).toBe(true);
    expect(episodeIdOf(profile.id, "headache")).toBeNull();
  });
});

describe("setSymptomEpisode — detach / attach (#1093)", () => {
  it("detaches a linked symptom (episodeId omitted ⇒ null)", async () => {
    const login = createLogin();
    const profile = createProfile("Detach Actor", login.id);
    actAs(login, profile);
    const epId = createEpisodeRow(profile.id, "Illness", "2026-03-03", null);
    await logSymptom(fd({ symptom: "cough", severity: 3, date: DATE }));
    expect(episodeIdOf(profile.id, "cough")).toBe(epId);

    const res = await setSymptomEpisode(fd({ symptom: "cough", date: DATE }));
    expect(res.ok).toBe(true);
    expect(episodeIdOf(profile.id, "cough")).toBeNull();
    expect(getEpisodeSymptomLogs(profile.id, epId)).toHaveLength(0);
    expect(revalidate).toHaveBeenCalledWith("/medical/episodes/[id]", "page");
  });

  it("re-attaches by explicit episode id", async () => {
    const login = createLogin();
    const profile = createProfile("Reattach Actor", login.id);
    actAs(login, profile);
    const epId = createEpisodeRow(profile.id, "Illness", "2026-03-03", null);
    await logSymptom(fd({ symptom: "cough", severity: 3, date: DATE }));
    await setSymptomEpisode(fd({ symptom: "cough", date: DATE })); // detach
    expect(episodeIdOf(profile.id, "cough")).toBeNull();

    const res = await setSymptomEpisode(
      fd({ symptom: "cough", date: DATE, episodeId: epId })
    );
    expect(res.ok).toBe(true);
    expect(episodeIdOf(profile.id, "cough")).toBe(epId);
  });

  it("rejects a cross-profile episode id (data-layer ownership gate)", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Owner", admin.id);
    const other = createProfile("Stranger", admin.id);
    actAs(admin, profile);
    createEpisodeRow(profile.id, "Illness", "2026-03-03", null);
    await logSymptom(fd({ symptom: "cough", severity: 3, date: DATE }));
    const foreignEp = createEpisodeRow(other.id, "Illness", "2026-03-03", null);

    // Admin CAN write to `profile`, but the target episode belongs to `other`.
    const res = await setSymptomEpisode(
      fd({ symptom: "cough", date: DATE, episodeId: foreignEp })
    );
    expect(res.ok).toBe(false);
    // The symptom's own episode link is untouched by the rejected write.
    expect(episodeIdOf(profile.id, "cough")).not.toBe(foreignEp);
  });

  it("refuses a cross-profile target the acting member has no grant for", async () => {
    // Owner member with a grant to their own profile only.
    const member = createLogin({ role: "member" });
    const own = createProfile("Member Own", member.id);
    // A profile the member is NOT granted (created under a different admin login).
    const admin = createLogin({ role: "admin" });
    const foreign = createProfile("Ungranted", admin.id);
    const foreignEp = createEpisodeRow(
      foreign.id,
      "Illness",
      "2026-03-03",
      null
    );
    actAs(member, own);

    // Posting an explicit cross-profile target the member can't reach must throw at the
    // requireProfileWriteAccess gate (surfaced as a rejected promise in the mock).
    await expect(
      setSymptomEpisode(
        fd({
          symptom: "cough",
          date: DATE,
          episodeId: foreignEp,
          profileId: foreign.id,
        })
      )
    ).rejects.toThrow();
  });
});
