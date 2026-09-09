// One act, one correction. Membership is read without freshness/eligibility limits;
// the existing domain cores still own every UPDATE and counter adjustment.
import { hoistedStatement, readTx, writeTx } from "./db";
import { getTimezone } from "./settings";
import { toUtcInstant, utcMinute } from "./date";
import {
  burstChipTarget,
  isBurstFresh,
  isOfferedHour,
  offeredHourInstant,
  summarizeBurst,
  type CorrectionBurst,
  type CorrectionPickerStep,
  type TapEvent,
} from "./correction-time";
import { restampFoodEventsCore } from "./food-log-write";
import { restampDoseLogsCore } from "./queries/intake/adherence";
import { restampPracticeLogsCore } from "./practice-log";
import {
  PRACTICE_CORRECTION_ELIGIBLE_SQL,
  practiceCorrectionTap,
  type PracticeCorrectionRow,
} from "./queries/wellness";

export type CorrectionDomain = "food" | "dose" | "practice";
export interface CorrectionAnchor {
  domain: CorrectionDomain;
  id: number;
}
export type BundleCorrectionMember = TapEvent &
  (
    | { domain: "food"; groupKey: string; date: string }
    | { domain: "dose"; doseId: number; date: string }
    | { domain: "practice"; localDay: string }
  );
export interface CorrectionBundle {
  id: string;
  members: BundleCorrectionMember[];
  burst: CorrectionBurst;
}

const FOOD_ANCHOR = hoistedStatement(
  "SELECT bundle_id FROM food_log_events WHERE profile_id = ? AND id = ?"
);
const DOSE_ANCHOR = hoistedStatement(`
  SELECT l.bundle_id FROM intake_item_logs l
  JOIN intake_item_doses d ON d.id = l.dose_id
  JOIN intake_items i ON i.id = d.item_id WHERE i.profile_id = ? AND l.id = ?`);
const PRACTICE_ANCHOR = hoistedStatement(
  "SELECT bundle_id FROM practice_logs WHERE profile_id = ? AND id = ?"
);
const FOOD_MEMBERS = hoistedStatement(`
  SELECT id, group_key AS groupKey, date, recorded_at AS tapAt,
         occurred_at AS statedAt, notify_message_id AS messageRef
  FROM food_log_events WHERE profile_id = ? AND bundle_id = ? ORDER BY id`);
const DOSE_MEMBERS = hoistedStatement(`
  SELECT l.id, l.dose_id AS doseId, l.date, l.status, l.recorded_at AS tapAt,
         l.occurred_at AS statedAt, l.notify_message_id AS messageRef, i.name AS label
  FROM intake_item_logs l JOIN intake_item_doses d ON d.id = l.dose_id
  JOIN intake_items i ON i.id = d.item_id
  WHERE i.profile_id = ? AND l.bundle_id = ? ORDER BY l.id`);
const PRACTICE_MEMBERS = hoistedStatement(`
  SELECT id, practice, date, start_time, end_time, duration_min, logged_via,
         created_at, notify_message_id, bundle_id,
         CASE WHEN ${PRACTICE_CORRECTION_ELIGIBLE_SQL} THEN 1 ELSE 0 END AS eligible
  FROM practice_logs WHERE profile_id = ? AND bundle_id = ? ORDER BY id`);

// The ID is obtained from a typed, profile-owned row, never from a callback payload.
export function readCorrectionBundle(
  profileId: number,
  anchor: CorrectionAnchor
): CorrectionBundle | null {
  return readTx(() => {
    const statement =
      anchor.domain === "food"
        ? FOOD_ANCHOR
        : anchor.domain === "dose"
          ? DOSE_ANCHOR
          : PRACTICE_ANCHOR;
    const anchored = statement.get(profileId, anchor.id) as
      { bundle_id: string | null } | undefined;
    if (anchored?.bundle_id == null) return null;
    const id = anchored.bundle_id;
    const food = FOOD_MEMBERS.all(profileId, id) as {
      id: number;
      groupKey: string;
      date: string;
      tapAt: string;
      statedAt: string | null;
      messageRef: number | null;
    }[];
    const doses = DOSE_MEMBERS.all(profileId, id) as {
      id: number;
      doseId: number;
      date: string;
      status: string;
      tapAt: string;
      statedAt: string | null;
      messageRef: number | null;
      label: string;
    }[];
    const practices = PRACTICE_MEMBERS.all(
      profileId,
      id
    ) as (PracticeCorrectionRow & { eligible: number })[];
    const members: BundleCorrectionMember[] = [];
    for (const row of food) {
      const tapAt = toUtcInstant(row.tapAt);
      const statedAt = toUtcInstant(row.statedAt);
      if (!tapAt || (row.statedAt != null && !statedAt)) return null;
      members.push({
        ...row,
        tapAt,
        statedAt,
        label: row.groupKey,
        domain: "food",
        bundleId: id,
      });
    }
    for (const row of doses) {
      const tapAt = toUtcInstant(row.tapAt);
      const statedAt = toUtcInstant(row.statedAt);
      if (row.status !== "taken" || !tapAt || !statedAt) return null;
      members.push({ ...row, tapAt, statedAt, domain: "dose", bundleId: id });
    }
    const tz = getTimezone(profileId);
    for (const row of practices) {
      if (!row.eligible) return null;
      const tap = practiceCorrectionTap(row, tz);
      if (!tap) return null;
      members.push({ ...tap, domain: "practice" });
    }
    const burst = summarizeBurst(members);
    if (!burst) return null;
    const ownIds = members
      .filter((m) => m.domain === anchor.domain)
      .map((m) => m.id);
    return {
      id,
      members,
      burst: {
        ...burst,
        fromId: Math.min(...ownIds),
        ids: ownIds,
        bundle: {
          id,
          practiceDays: [...new Set(practices.map((p) => p.date))],
        },
      },
    };
  });
}

export type BundleTimeChoice =
  | { kind: "chip"; minutesBack: number }
  | Extract<CorrectionPickerStep, { kind: "at" }>;

type BundleRestampRefusal = {
  kind: "no-burst" | "not-bound" | "out-of-range" | "crosses-day" | "lapsed";
};
export type BundleRestampOutcome =
  | BundleRestampRefusal
  | {
      kind: "restamped";
      foodCount: number;
      doseCount: number;
      practiceCount: number;
      movedDays: number;
      crossedMidnight: boolean;
      at: Date;
    };
class RefusedBundleCorrection extends Error {
  constructor(readonly outcome: BundleRestampRefusal) {
    super(outcome.kind);
  }
}

// The callback supplies current authority/binding as one fresh predicate. It runs
// inside this outer transaction, before any nested domain savepoint can write.
export function restampCorrectionBundle(
  profileId: number,
  anchor: CorrectionAnchor,
  expectedBundleId: string,
  choice: BundleTimeChoice,
  now: Date,
  stillBound: (bundle: CorrectionBundle) => boolean
): BundleRestampOutcome {
  try {
    return writeTx(() => {
      const bundle = readCorrectionBundle(profileId, anchor);
      if (!bundle) return { kind: "no-burst" as const };
      if (bundle.id !== expectedBundleId || !stillBound(bundle))
        return { kind: "not-bound" as const };
      if (!isBurstFresh(bundle.burst, now)) return { kind: "lapsed" as const };
      const tz = getTimezone(profileId);
      let at =
        choice.kind === "chip"
          ? burstChipTarget(bundle.burst, choice.minutesBack, now, tz)
          : isOfferedHour(
                choice.hhmm,
                bundle.burst,
                now,
                tz,
                false,
                choice.day,
                choice.date ?? null
              )
            ? offeredHourInstant(choice.hhmm, choice.day, now, tz)
            : null;
      if (!at) return { kind: "out-of-range" as const };
      if (bundle.burst.bundle?.practiceDays.length)
        at = new Date(utcMinute(at));
      const target = at;
      const ids = (domain: CorrectionDomain) =>
        bundle.members.filter((m) => m.domain === domain).map((m) => m.id);
      const food = ids("food"),
        doses = ids("dose"),
        practices = ids("practice");
      let movedDays = 0,
        crossedMidnight = false;
      if (food.length) {
        const result = restampFoodEventsCore(
          profileId,
          { ids: food },
          () => target
        );
        if (result.kind !== "restamped")
          throw new RefusedBundleCorrection(result);
        movedDays = result.movedDays;
      }
      if (doses.length) {
        const result = restampDoseLogsCore(
          profileId,
          { ids: doses },
          () => target
        );
        if (result.kind !== "restamped")
          throw new RefusedBundleCorrection(result);
        crossedMidnight = result.crossedMidnight;
      }
      if (practices.length) {
        const result = restampPracticeLogsCore(
          profileId,
          { ids: practices },
          () => target
        );
        if (result.kind !== "restamped")
          throw new RefusedBundleCorrection(result);
      }
      return {
        kind: "restamped" as const,
        at: target,
        foodCount: food.length,
        doseCount: doses.length,
        practiceCount: practices.length,
        movedDays,
        crossedMidnight,
      };
    });
  } catch (error) {
    if (error instanceof RefusedBundleCorrection) return error.outcome;
    throw error;
  }
}
