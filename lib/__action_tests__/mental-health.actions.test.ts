// SERVER-ACTION TIER (#716) — the mental-health instrument write path. The action derives
// the total from the per-item answers (server is the source of truth, so a tampered total
// can't disagree), validates the outside-score bounds, and gates on requireWriteAccess.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordInstrumentAction } from "@/app/(app)/medical/instruments/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

function phqRow(profileId: number) {
  return db
    .prepare(
      `SELECT value_num, canonical_name FROM medical_records
       WHERE profile_id = ? AND canonical_name = 'PHQ-9' ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as
    { value_num: number; canonical_name: string } | undefined;
}

describe("recordInstrumentAction", () => {
  it("administers a PHQ-9 in-app: total is derived from the 9 answers, item answers stored", async () => {
    const login = createLogin();
    const profile = createProfile("mh-admin", login.id);
    actAs(login, profile);

    const answers = [1, 2, 1, 0, 3, 0, 1, 2, 1]; // sum = 11 → moderate
    const r = await recordInstrumentAction(
      fd({
        instrument: "PHQ-9",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify(answers),
      })
    );
    expect(r.ok).toBe(true);

    const row = phqRow(profile.id);
    expect(row?.value_num).toBe(11);
    const respCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM instrument_responses WHERE profile_id = ?"
      )
      .get(profile.id) as { n: number };
    expect(respCount.n).toBe(9);
  });

  it("rejects an incomplete in-app administration", async () => {
    const login = createLogin();
    const profile = createProfile("mh-incomplete", login.id);
    actAs(login, profile);
    const r = await recordInstrumentAction(
      fd({
        instrument: "PHQ-9",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([1, 2, 3]), // only 3 of 9
      })
    );
    expect(r.ok).toBe(false);
  });

  it("accepts an outside total-only GAD-7 score (no item answers)", async () => {
    const login = createLogin();
    const profile = createProfile("mh-outside", login.id);
    actAs(login, profile);
    const r = await recordInstrumentAction(
      fd({
        instrument: "GAD-7",
        mode: "outside",
        date: "2026-07-01",
        total: "13",
      })
    );
    expect(r.ok).toBe(true);
    const row = db
      .prepare(
        `SELECT value_num FROM medical_records WHERE profile_id = ? AND canonical_name = 'GAD-7'`
      )
      .get(profile.id) as { value_num: number } | undefined;
    expect(row?.value_num).toBe(13);
    const respCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM instrument_responses WHERE profile_id = ?"
      )
      .get(profile.id) as { n: number };
    expect(respCount.n).toBe(0);
  });

  it("rejects an out-of-range outside total", async () => {
    const login = createLogin();
    const profile = createProfile("mh-oob", login.id);
    actAs(login, profile);
    const r = await recordInstrumentAction(
      fd({
        instrument: "GAD-7",
        mode: "outside",
        date: "2026-07-01",
        total: "99",
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown instrument", async () => {
    const login = createLogin();
    const profile = createProfile("mh-bad", login.id);
    actAs(login, profile);
    const r = await recordInstrumentAction(
      fd({
        instrument: "BOGUS",
        mode: "outside",
        date: "2026-07-01",
        total: "1",
      })
    );
    expect(r.ok).toBe(false);
  });
});
