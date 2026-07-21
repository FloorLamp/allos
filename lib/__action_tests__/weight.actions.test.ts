// SERVER-ACTION TIER — weight/body-metric write path.
//
// Proves the real addBodyMetric/deleteBodyMetric actions run through the (mocked)
// auth guard, convert to canonical kg using the acting LOGIN's unit prefs, reject
// invalid input, revalidate, and scope every write to the acting profile.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addBodyMetric,
  deleteBodyMetric,
} from "@/app/(app)/trends/body-actions";
import { LB_PER_KG } from "@/lib/units";
import { getBodyMetrics } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function bodyMetricRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, date, weight_kg FROM body_metrics WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as { id: number; date: string; weight_kg: number }[];
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("addBodyMetric", () => {
  it("stores weight converted to kg from a lb-pref login", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("lb-user", login.id);
    actAs(login, profile);

    await addBodyMetric(fd({ date: "2026-02-01", weight: 220 }));

    const rows = bodyMetricRows(profile.id);
    expect(rows).toHaveLength(1);
    // 220 lb → kg. Assert canonical storage, not the display value.
    expect(rows[0].weight_kg).toBeCloseTo(220 / LB_PER_KG, 6);
    expect(rows[0].weight_kg).not.toBeCloseTo(220, 1);
    expect(rows[0].date).toBe("2026-02-01");
    expect(revalidate).toHaveBeenCalledWith("/trends");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("stores weight as-entered for a kg-default login", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("kg-user", login.id);
    actAs(login, profile);

    await addBodyMetric(fd({ date: "2026-02-02", weight: 80 }));

    expect(bodyMetricRows(profile.id)[0].weight_kg).toBeCloseTo(80, 6);
  });

  it("honors the unit captured when the form rendered", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("captured-lb-user", login.id);
    actAs(login, profile);

    await addBodyMetric(
      fd({ date: "2026-02-02", weight: 44, weight_unit: "lb" })
    );

    expect(bodyMetricRows(profile.id)[0].weight_kg).toBeCloseTo(
      44 / LB_PER_KG,
      6
    );
  });

  it("rejects an impossible date (no row written)", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("bad-date", login.id);
    actAs(login, profile);

    await addBodyMetric(fd({ date: "2026-13-45", weight: 80 }));

    expect(bodyMetricRows(profile.id)).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric weight (no NaN row written)", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("nan-weight", login.id);
    actAs(login, profile);

    await addBodyMetric(fd({ date: "2026-02-03", weight: "abc" }));

    expect(bodyMetricRows(profile.id)).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects a missing weight", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("no-weight", login.id);
    actAs(login, profile);

    await addBodyMetric(fd({ date: "2026-02-04" }));

    expect(bodyMetricRows(profile.id)).toHaveLength(0);
  });
});

describe("deleteBodyMetric", () => {
  it("removes only the acting profile's row and revalidates", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("del-user", login.id);
    actAs(login, profile);

    await addBodyMetric(fd({ date: "2026-02-05", weight: 81 }));
    const id = bodyMetricRows(profile.id)[0].id;
    revalidate.mockClear();

    await deleteBodyMetric(fd({ id }));

    expect(bodyMetricRows(profile.id)).toHaveLength(0);
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });
});

describe("scoping", () => {
  it("writes to the acting profile only; a second profile is untouched", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profileA = createProfile("A", login.id);
    const profileB = createProfile("B", login.id);

    actAs(login, profileA);
    await addBodyMetric(fd({ date: "2026-03-01", weight: 70 }));

    // Nothing landed in B, and B's reads are unaffected by A's write.
    expect(bodyMetricRows(profileB.id)).toHaveLength(0);
    expect(getBodyMetrics(profileB.id)).toHaveLength(0);
    expect(getBodyMetrics(profileA.id)).toHaveLength(1);
  });

  it("delete cannot reach across profiles (id belongs to another profile)", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profileA = createProfile("A2", login.id);
    const profileB = createProfile("B2", login.id);

    actAs(login, profileB);
    await addBodyMetric(fd({ date: "2026-03-02", weight: 90 }));
    const bId = bodyMetricRows(profileB.id)[0].id;

    // Act as A and try to delete B's row by id — the action's profile_id filter
    // (there is no profile_id INPUT to tamper) makes this a no-op by construction.
    actAs(login, profileA);
    await deleteBodyMetric(fd({ id: bId }));

    expect(bodyMetricRows(profileB.id)).toHaveLength(1);
  });
});
