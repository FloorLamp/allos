import type { IntegrationId } from "@/lib/types";
import { getHomeLocation } from "@/lib/settings";
import { PULL_INTEGRATIONS } from "./registry";
import { runStravaSync, type StravaSyncResult } from "./strava-sync";
import { runOuraSync, type OuraSyncResult } from "./oura-sync";
import { runWithingsSync, type WithingsSyncResult } from "./withings-sync";
import { runWeatherSync, type WeatherSyncResult } from "./weather-sync";

// The RUNNABLE half of the pull facet (#2040). `lib/integrations/registry.ts` stays
// data-only — it is imported by the pure tier and by client components — so the
// functions that actually sync are bound here, keyed by the same registry ids.
//
// Everything above this file dispatches through it: the one generic "Sync now"
// action and the hourly notify tick used to name four sources each, in four
// copy-pasted blocks. Adding Garmin is one registry facet plus one entry here.

export interface PullRunnerResult {
  // The source's own count keys, for the outcome sentence.
  [key: string]: unknown;
}

export interface PullRunner {
  id: IntegrationId;
  // A precondition this source states better than a generic failure would — the
  // weather pull needs a home location, and "Set your home location first" is a
  // different message from "Sync failed". Null when the source is ready.
  blockedReason?(profileId: number): string | null;
  // The idempotent pull itself. Never throws for an ordinary source/network
  // problem; returns `{ error }` instead.
  run(profileId: number): Promise<PullRunnerResult | { error: string }>;
  // The done-message for a completed run, in the source's own vocabulary.
  describe(result: PullRunnerResult): string;
}

// Bind one source's typed run + describe into the erased shape above, so each
// entry keeps its own result type at the definition site.
function runner<T extends object>(
  id: IntegrationId,
  spec: {
    run(profileId: number): Promise<T | { error: string }>;
    describe(result: T): string;
    blockedReason?(profileId: number): string | null;
  }
): PullRunner {
  return {
    id,
    blockedReason: spec.blockedReason,
    run: (profileId) =>
      spec.run(profileId) as Promise<PullRunnerResult | { error: string }>,
    describe: (result) => spec.describe(result as T),
  };
}

// "(more to come next sync)" — the shared suffix for a run the source cut short.
function moreToCome(truncated: boolean | undefined): string {
  return truncated ? " (more to come next sync)" : "";
}

const RUNNERS: PullRunner[] = [
  runner<StravaSyncResult>("strava", {
    run: runStravaSync,
    describe: (res) => {
      const parts = [
        `${res.activities} ${res.activities === 1 ? "activity" : "activities"}`,
      ];
      if (res.samples > 0)
        parts.push(
          `${res.samples} ${res.samples === 1 ? "sample" : "samples"}`
        );
      return `Synced ${parts.join(", ")}.${moreToCome(res.truncated)}`;
    },
  }),
  runner<OuraSyncResult>("oura", {
    run: runOuraSync,
    describe: (res) => {
      const parts = [
        `${res.workouts} ${res.workouts === 1 ? "workout" : "workouts"}`,
      ];
      const nights = res.bodyMetrics + res.samples;
      if (nights > 0) parts.push(`${nights} sleep/HR records`);
      return `Synced ${parts.join(", ")}.${moreToCome(res.truncated)}`;
    },
  }),
  runner<WithingsSyncResult>("withings", {
    run: runWithingsSync,
    describe: (res) => {
      const parts: string[] = [];
      if (res.bodyMetrics > 0)
        parts.push(
          `${res.bodyMetrics} body ${res.bodyMetrics === 1 ? "record" : "records"}`
        );
      if (res.vitals > 0)
        parts.push(`${res.vitals} ${res.vitals === 1 ? "vital" : "vitals"}`);
      if (res.samples > 0)
        parts.push(
          `${res.samples} sleep ${res.samples === 1 ? "record" : "records"}`
        );
      const what = parts.length ? parts.join(", ") : "no new readings";
      return `Synced ${what}.${moreToCome(res.truncated)}`;
    },
  }),
  runner<WeatherSyncResult>("weather", {
    // Keyless: the only prerequisite is a home location, and saying so is far more
    // useful than the generic "Sync failed" the runner would otherwise produce.
    blockedReason: (profileId) =>
      getHomeLocation(profileId)
        ? null
        : "Set your home location first (Settings → Profile).",
    run: (profileId) => runWeatherSync(profileId),
    describe: (res) =>
      `Refreshed ${res.hours} ${res.hours === 1 ? "hour" : "hours"} and ` +
      `${res.days} ${res.days === 1 ? "day" : "days"} of forecast.` +
      (res.partial ? " (air quality unavailable this run)" : ""),
  }),
];

export function getPullRunner(id: string): PullRunner | undefined {
  return RUNNERS.find((r) => r.id === id);
}

// Every registered pull source, in registry order — what the hourly tick iterates.
// Sourced from the registry rather than from RUNNERS so a facet with no runner bound
// fails loudly at startup instead of silently never syncing.
export function pullRunners(): PullRunner[] {
  return PULL_INTEGRATIONS.map((def) => {
    const found = getPullRunner(def.id);
    if (!found) {
      throw new Error(`integration '${def.id}' declares pull with no runner`);
    }
    return found;
  });
}
