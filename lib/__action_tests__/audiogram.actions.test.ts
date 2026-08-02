// SERVER-ACTION TIER — the hearing/audiogram write boundary (issue #1600).
//
// Drives the real addAudiogram / removeAudiogram Server Actions against the throwaway
// temp DB with the auth boundary mocked by setup.ts. Asserts what belongs to the
// request boundary and nowhere else: the write-access gate, date + threshold
// validation, the typed refusal an all-blank submit gets, and that the readings land on
// the acting profile (never another one).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  addAudiogram,
  removeAudiogram,
} from "@/app/(app)/records/specialty/hearing/actions";
import { getAudiogramReadings, getAudiograms } from "@/lib/audiogram-records";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("addAudiogram action", () => {
  it("stores the filled thresholds on the acting profile and revalidates the reading surfaces", async () => {
    const { profile } = seedActor();
    const res = await addAudiogram(
      fd({
        date: "2026-06-01",
        right_1000: "15",
        right_4000: "40",
        left_4000: "",
        notes: "post-course monitoring",
      })
    );
    expect(res.ok).toBe(true);

    const readings = getAudiogramReadings(profile.id);
    // The blank left-4 kHz field is "not tested" — it must not become a stored 0.
    expect(readings).toHaveLength(2);
    expect(readings.map((r) => r.dbHl).sort((a, b) => a - b)).toEqual([15, 40]);
    expect(readings.every((r) => r.notes === "post-course monitoring")).toBe(
      true
    );
    // The thresholds ARE biomarker readings, so the catalog and the safety strips
    // must refresh with them.
    expect(revalidate).toHaveBeenCalledWith("/records");
    expect(revalidate).toHaveBeenCalledWith("/results");
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  it("refuses a missing or unreal date", async () => {
    seedActor();
    expect((await addAudiogram(fd({ right_1000: "15" }))).ok).toBe(false);
    expect(
      (await addAudiogram(fd({ date: "2026-02-31", right_1000: "15" }))).ok
    ).toBe(false);
  });

  it("refuses an all-blank submit with its typed reason, storing nothing", async () => {
    const { profile } = seedActor();
    const res = await addAudiogram(fd({ date: "2026-06-01", notes: "oops" }));
    expect(res).toEqual({
      ok: false,
      error: "Enter at least one threshold, in dB HL.",
    });
    expect(getAudiograms(profile.id)).toEqual([]);
  });

  it("drops a value outside the audiometer's range rather than storing a typo", async () => {
    const { profile } = seedActor();
    const res = await addAudiogram(
      fd({
        date: "2026-06-01",
        right_1000: "400", // a slipped decimal — not a measurement
        right_4000: "abc",
        left_1000: "20",
      })
    );
    expect(res.ok).toBe(true);
    const readings = getAudiogramReadings(profile.id);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ ear: "left", hz: 1000, dbHl: 20 });
  });

  it("refuses a read-only acting session (requireWriteAccess)", async () => {
    const login = createLogin({});
    const profile = createProfile("hearing-ro", login.id);
    actAs(login, profile, "read");
    await expect(
      addAudiogram(fd({ date: "2026-06-01", right_1000: "15" }))
    ).rejects.toThrow();
    expect(getAudiograms(profile.id)).toEqual([]);
  });
});

describe("removeAudiogram action", () => {
  it("removes that date's thresholds and refuses one the profile doesn't have", async () => {
    const { profile } = seedActor();
    await addAudiogram(fd({ date: "2026-06-01", right_1000: "15" }));
    await addAudiogram(fd({ date: "2024-06-01", right_1000: "10" }));

    expect((await removeAudiogram(fd({ date: "2026-06-01" }))).ok).toBe(true);
    expect(getAudiograms(profile.id).map((a) => a.date)).toEqual([
      "2024-06-01",
    ]);

    expect(await removeAudiogram(fd({ date: "2030-01-01" }))).toEqual({
      ok: false,
      error: "Couldn't find that hearing test.",
    });
  });

  it("refuses a read-only acting session", async () => {
    const login = createLogin({});
    const profile = createProfile("hearing-ro-delete", login.id);
    actAs(login, profile, "write");
    await addAudiogram(fd({ date: "2026-06-01", right_1000: "15" }));
    actAs(login, profile, "read");
    await expect(removeAudiogram(fd({ date: "2026-06-01" }))).rejects.toThrow();
    expect(getAudiograms(profile.id)).toHaveLength(1);
  });
});
