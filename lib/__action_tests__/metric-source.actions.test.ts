// SERVER-ACTION TIER — per-metric primary-source write path (issue #14).
//
// Proves the real setMetricPrimarySource action runs through the (mocked) auth
// guard, persists the choice into the acting PROFILE's settings tier, allowlists
// the metric key, shape-checks the source id, clears back to automatic, and
// actually flips the source-aware reads.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { setMetricPrimarySource } from "@/app/(app)/trends/source-actions";
import { getMetricDailyTotals } from "@/lib/queries";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import { getMetricSourcePriority } from "@/lib/settings";
import { METRIC_SOURCE_PRIORITY_KEY } from "@/lib/metric-source-priority";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function storedBlob(profileId: number): string | undefined {
  const row = db
    .prepare(
      "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
    )
    .get(profileId, METRIC_SOURCE_PRIORITY_KEY) as
    { value?: string } | undefined;
  return row?.value;
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("setMetricPrimarySource", () => {
  it("persists the choice for the ACTING profile and revalidates", async () => {
    const login = createLogin();
    const profile = createProfile("source-picker", login.id);
    const other = createProfile("bystander", login.id);
    actAs(login, profile);

    await setMetricPrimarySource(fd({ metric: "steps", source: "oura" }));

    expect(getMetricSourcePriority(profile.id)).toEqual({ steps: "oura" });
    expect(getMetricSourcePriority(other.id)).toEqual({}); // profile-scoped
    expect(revalidate).toHaveBeenCalledWith("/trends");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("an empty source clears back to automatic (key removed once empty)", async () => {
    const login = createLogin();
    const profile = createProfile("source-clearer", login.id);
    actAs(login, profile);

    await setMetricPrimarySource(fd({ metric: "sleep_min", source: "oura" }));
    expect(getMetricSourcePriority(profile.id)).toEqual({ sleep_min: "oura" });

    await setMetricPrimarySource(fd({ metric: "sleep_min", source: "" }));
    expect(getMetricSourcePriority(profile.id)).toEqual({});
    expect(storedBlob(profile.id)).toBeUndefined(); // empty map deletes the key
  });

  it("rejects a non-allowlisted metric key and a malformed source id", async () => {
    const login = createLogin();
    const profile = createProfile("source-forger", login.id);
    actAs(login, profile);

    await setMetricPrimarySource(
      fd({ metric: "telegram_chat_id", source: "oura" })
    );
    await setMetricPrimarySource(
      fd({ metric: "steps", source: '{"blob":true}' })
    );

    expect(storedBlob(profile.id)).toBeUndefined();
  });

  it("the persisted choice flips the additive daily rollup", async () => {
    const login = createLogin();
    const profile = createProfile("source-reader", login.id);
    actAs(login, profile);

    const sample = (value: number) => ({
      metric: "steps",
      date: "2024-03-01",
      start_time: "2024-03-01T00:00",
      end_time: "2024-03-01T23:59",
      value,
    });
    upsertMetricSamples(profile.id, [sample(9000)], "health-connect");
    upsertMetricSamples(profile.id, [sample(7500)], "oura");

    expect(getMetricDailyTotals(profile.id, "steps")).toEqual([
      { date: "2024-03-01", value: 9000 },
    ]);

    await setMetricPrimarySource(fd({ metric: "steps", source: "oura" }));
    expect(getMetricDailyTotals(profile.id, "steps")).toEqual([
      { date: "2024-03-01", value: 7500 },
    ]);
  });
});
