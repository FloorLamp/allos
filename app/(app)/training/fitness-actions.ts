"use server";

// Server Actions for the guided Fitness check (issue #834). The ONE auth boundary: every
// action gates with requireWriteAccess() (write tier — uniform per #319), resolves the
// acting profile from the session, derives the canonical value (VO2 from a field test,
// e1RM from weight×reps, HRR/SRT from their scored inputs), then calls the auth-blind
// write core (lib/fitness-assessment) and revalidates /training. The core is profileId-
// first and never imports lib/auth.

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  saveFitnessEntry,
  type FitnessEntryOutcome,
} from "@/lib/fitness-assessment";
import { fitnessTest, computeVo2, type Vo2Method } from "@/lib/fitness-battery";
import { heartRateRecovery, sittingRisingResult } from "@/lib/vo2-field-tests";
import { estimate1RM } from "@/lib/strength";
import { liftInfo } from "@/lib/lifts";
import { toKg, kgTo } from "@/lib/units";
import { getUserSex, getUserAgeOn, getUnitPrefs } from "@/lib/settings";
import { setFitnessRetestCadenceDays } from "@/lib/settings";
import { getLatestBodyMetric } from "@/lib/queries";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";
import { buildFitnessTiles } from "@/lib/fitness-tile";
import {
  buildFitnessOutcome,
  batteryCompletion,
  batteryCompletionSummary,
  type FitnessOutcome,
  type BatteryCompletionSummary,
} from "@/lib/fitness-outcome";
import { withFindingClosure, formatClosureToast } from "@/lib/finding-closure";
import { closureFindingSnapshot } from "@/lib/rule-findings";
import { FITNESS_CHECK_PREFIX } from "@/lib/fitness-retest";

// The per-test outcome moment (#1307) + finding-closure toast (#1305) ride back on the
// typed success result: `outcome` is the just-saved test's percentile/band/delta (null if
// the save didn't resolve a measured tile — e.g. a self-trend residue), `finale` is the
// battery-completion summary ONLY on the save that FLIPS the battery to complete, and
// `closureToast` is the honest one-line acknowledgment when this save cleared a fitness
// finding (the first save of a new check — later saves clear nothing and toast nothing).
export type SaveFitnessTestResult =
  | {
      ok: true;
      outcome: FitnessOutcome | null;
      finale: BatteryCompletionSummary | null;
      closureToast: string | null;
    }
  | { ok: false; error: string };

// A bare success/failure shape for the sibling cadence action (no outcome/finale).
export type SaveResult = { ok: true } | { ok: false; error: string };

function num(fd: FormData, key: string): number | null {
  const v = fd.get(key);
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Record one battery test in the acting profile's session for a date. Derives the
// canonical value per input kind, then hands it to the write core.
export async function saveFitnessTest(
  fd: FormData
): Promise<SaveFitnessTestResult> {
  const { login, profile } = await requireWriteAccess();

  const testKey = String(fd.get("testKey") ?? "");
  const def = fitnessTest(testKey);
  if (!def) return { ok: false, error: "unknown test" };

  const dateRaw = String(fd.get("date") ?? "");
  const date = isRealIsoDate(dateRaw) ? dateRaw : today(profile.id);
  const note = fd.get("note") ? String(fd.get("note")) : null;

  const sex = getUserSex(profile.id);
  const age = getUserAgeOn(profile.id, date);
  const weightUnit = getUnitPrefs(login.id).weightUnit;

  let value: number | null = null;
  let rawInput: unknown = undefined;
  let liftName: string | undefined;
  let reps: number | null = null;
  let weightKg: number | null = null;
  let durationSec: number | null = null;

  switch (def.inputKind) {
    case "vo2": {
      const method = String(fd.get("method") ?? "watch") as Vo2Method;
      const weightKgLatest = getLatestBodyMetric(profile.id, "weight");
      const est = computeVo2(
        method,
        {
          watchValue: num(fd, "watchValue"),
          distanceMeters: num(fd, "distanceMeters"),
          walkTimeMin: num(fd, "walkTimeMin"),
          walkHr: num(fd, "walkHr"),
          weightLb: weightKgLatest != null ? kgTo(weightKgLatest, "lb") : null,
          stepRecoveryHr: num(fd, "stepRecoveryHr"),
        },
        sex,
        age
      );
      if (!est) return { ok: false, error: "enter the field-test inputs" };
      value = est.vo2;
      rawInput = { method, ...methodInputs(method, fd) };
      break;
    }
    case "hrr": {
      const res = heartRateRecovery(num(fd, "peakHr"), num(fd, "oneMinuteHr"));
      if (!res) return { ok: false, error: "enter both heart rates" };
      value = res.hrr;
      rawInput = {
        peakHr: num(fd, "peakHr"),
        oneMinuteHr: num(fd, "oneMinuteHr"),
        band: res.band,
      };
      break;
    }
    case "e1rm": {
      const lift = String(fd.get("lift") ?? "").trim();
      if (!lift || !liftInfo(lift))
        return { ok: false, error: "pick a valid lift" };
      const weight = num(fd, "weight");
      const r = num(fd, "reps");
      if (weight == null || r == null || weight <= 0 || r <= 0)
        return { ok: false, error: "enter the weight and reps" };
      const setKg = toKg(weight, weightUnit);
      value = estimate1RM(setKg, r);
      liftName = lift;
      weightKg = setKg;
      reps = r;
      rawInput = { lift, weightKg: setKg, reps: r };
      break;
    }
    case "reps":
    case "seconds":
    case "number": {
      const raw = num(fd, "value");
      if (raw == null) return { ok: false, error: "enter a value" };
      // The sitting-rising test snaps to its published half-point scale.
      value =
        testKey === "srt" ? (sittingRisingResult(raw)?.score ?? null) : raw;
      if (value == null) return { ok: false, error: "invalid value" };
      if (def.store.kind === "set") {
        if (def.store.timed) durationSec = value;
        else reps = value;
      }
      break;
    }
    default:
      return { ok: false, error: "unsupported test" };
  }

  if (value == null || !Number.isFinite(value))
    return { ok: false, error: "invalid value" };

  // Battery completion BEFORE the write, so the finale fires only on the save that FLIPS
  // it to complete (#1307) — not on every save once complete.
  const before = assembleFitnessCheckModel(profile.id);
  const wasComplete = batteryCompletion(
    before.model.results,
    before.equipmentMissingKeys
  ).complete;

  // Wrap the write in the finding-closure loop (#1305): the FIRST save of a new check
  // clears the "Fitness check due" retest finding (battery-level, keyed on the last-check
  // date), so it toasts once; later saves this check find nothing active and stay silent.
  const prefixes = [FITNESS_CHECK_PREFIX];
  const { result: outcome, cleared } = withFindingClosure(
    profile.id,
    prefixes,
    (pid, todayISO) => closureFindingSnapshot(pid, prefixes, todayISO),
    (): FitnessEntryOutcome =>
      saveFitnessEntry(profile.id, {
        date,
        testKey,
        value,
        rawInput,
        note,
        liftName,
        reps,
        weightKg,
        durationSec,
      })
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };

  // Rebuild the model AFTER the write for the outcome moment + finale — the SAME assembler
  // the page section uses, so the modal's outcome and the grid tile can never disagree.
  const after = assembleFitnessCheckModel(profile.id);
  const savedTile = buildFitnessTiles(after.model.results).find(
    (t) => t.key === testKey
  );
  const testOutcome =
    savedTile && savedTile.measured ? buildFitnessOutcome(savedTile) : null;
  const nowComplete = batteryCompletion(
    after.model.results,
    after.equipmentMissingKeys
  ).complete;
  const finale =
    !wasComplete && nowComplete
      ? batteryCompletionSummary(after.model, after.equipmentMissingKeys)
      : null;
  const closureToast = formatClosureToast(cleared, {
    // Multi-step honesty (#1305): the fitness retest finding is battery-level, so the
    // flip means the clock reset — not that the whole check is done.
    [FITNESS_CHECK_PREFIX]:
      "Fitness check refreshed — retest clock restarts today.",
  });

  revalidatePath("/training");
  return { ok: true, outcome: testOutcome, finale, closureToast };
}

function methodInputs(
  method: Vo2Method,
  fd: FormData
): Record<string, number | null> {
  switch (method) {
    case "watch":
      return { watchValue: num(fd, "watchValue") };
    case "cooper":
      return { distanceMeters: num(fd, "distanceMeters") };
    case "rockport":
      return { walkTimeMin: num(fd, "walkTimeMin"), walkHr: num(fd, "walkHr") };
    case "step":
      return { stepRecoveryHr: num(fd, "stepRecoveryHr") };
    default:
      return {};
  }
}

// Set the per-profile retest cadence (days) that drives the coaching-tier "check due"
// nudge. Profile-scoped write.
export async function setFitnessCadence(fd: FormData): Promise<SaveResult> {
  const { profile } = await requireWriteAccess();
  const days = num(fd, "days");
  if (days == null || days <= 0)
    return { ok: false, error: "enter a cadence in days" };
  setFitnessRetestCadenceDays(profile.id, days);
  revalidatePath("/training");
  return { ok: true };
}
