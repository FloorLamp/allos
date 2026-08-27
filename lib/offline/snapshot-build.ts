// SERVER-SIDE gathering for the offline read snapshots (issue #2908). One builder per
// registry kind, each a formatter over READ MODELS THAT ALREADY EXIST — the point of
// the registry is that nothing here is a second engine. If a builder ever needs to
// derive something the live page doesn't, that is the signal that the snapshot has
// stopped being a copy of a read and started being a read of its own.
//
// The pure registry, the payload shapes, the staleness rules and the queue overlay live
// in lib/offline/snapshots.ts. This module reaches the DB; it never touches the
// browser.
//
// FACTS, NEVER VERDICTS (owner decision 5). Nothing here stores a coaching output: no
// next-workout recommendation, no pace verdict, no adherence judgment computed against
// "now". A dated fact read three days later is still true and says how old it is; a
// frozen verdict read three days later is simply wrong, and the person has no way to
// tell. The one derived value that does ship — a dose's taken/skipped resolution — is a
// recorded event with a date on it, not an opinion about one.

import { today } from "@/lib/db";
import {
  getIntakeItems,
  getIntakeDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getActivities,
  getMedicationCourses,
  getFoodServingsOnDate,
  getProteinDailyGrams,
  profileTracksProtein,
  getTrackedPractices,
  getRecentByExercise,
} from "@/lib/queries";
import {
  getActiveSituations,
  getTimezone,
  getDisplayFormatPrefs,
  getUnitPrefs,
} from "@/lib/settings";
import {
  doseDueOn,
  isOnDemand,
  timeBucket,
  TIME_BUCKET_LABELS,
} from "@/lib/intake-schedule";
import { buildMedicationList } from "@/lib/medication-list";
import { medicationStartDate } from "@/lib/profile-summary";
import { foodGroupBySlug } from "@/lib/food-groups";
import { utcInstant } from "@/lib/date";
import { doseSortKey, compareSortHint } from "@/lib/dose-order";
import {
  MAX_SNAPSHOT_ACTIVITIES,
  MAX_SNAPSHOT_DOSES,
  MAX_SNAPSHOT_EXERCISES,
  MAX_SNAPSHOT_FOOD_GROUPS,
  MAX_SNAPSHOT_MEDICATIONS,
  MAX_SNAPSHOT_PRACTICES,
  MAX_SNAPSHOT_SESSIONS,
  SNAPSHOT_KINDS,
  SNAPSHOT_VERSION,
  type AnySnapshot,
  type DoseScheduleEntry,
  type SnapshotDataByKind,
  type SnapshotKind,
} from "@/lib/offline/snapshots";

// Who a snapshot is FOR — resolved once at the request boundary and threaded through
// every builder, so no builder can read a profile it wasn't handed.
export interface SnapshotContext {
  profileId: number;
  // The profile's own timezone and its own today. Both travel INTO the payload: the
  // device re-derives "is this still today?" in the profile's zone, not its own.
  timeZone: string;
  date: string;
  loginId: number;
}

export function snapshotContext(
  profileId: number,
  loginId: number
): SnapshotContext {
  return {
    profileId,
    timeZone: getTimezone(profileId),
    date: today(profileId),
    loginId,
  };
}

// ── dose-schedule ────────────────────────────────────────────────────────────

function buildDoseSchedule(
  ctx: SnapshotContext
): SnapshotDataByKind["dose-schedule"] {
  const items = new Map(
    getIntakeItems(ctx.profileId)
      .filter((i) => i.active === 1)
      .map((i) => [i.id, i])
  );
  // The SAME day context every intake surface builds (the household card, the digest,
  // the reminders): dueness is `doseDueOn`, never a local filter, so an alternating-
  // amount pair or a taper window means the same thing offline as on the page (#1602).
  const dayCtx = {
    date: ctx.date,
    isWorkoutDay: getActivitiesByDate(ctx.profileId, ctx.date).length > 0,
    activeSituations: new Set(getActiveSituations(ctx.profileId)),
  };
  const taken = getTakenDoseIds(ctx.profileId, ctx.date);
  const skipped = getSkippedDoseIds(ctx.profileId, ctx.date);

  const rows: { key: string; entry: DoseScheduleEntry }[] = [];
  for (const dose of getIntakeDoses(ctx.profileId)) {
    const item = items.get(dose.item_id);
    if (!item) continue;
    if (!doseDueOn(item, dose, dayCtx)) continue;
    const bucket = timeBucket(dose.time_of_day);
    rows.push({
      // The SHARED dose ordering (#297) — the same key Upcoming and the Today panel
      // sort on, so the offline schedule is in the order the person already knows.
      key: doseSortKey({
        timeOfDay: dose.time_of_day,
        obligation: item.obligation,
        stack: item.stack,
        name: item.name,
      }),
      entry: {
        doseId: dose.id,
        name: item.name,
        detail: dose.amount,
        slot: TIME_BUCKET_LABELS[bucket] ?? null,
        // No `time`: the wall clock is what the rows are SORTED by (doseSortKey above,
        // which reads it) and it is rendered nowhere, so it does not need to be at rest
        // on the device. Same projection rule as the medication list below.
        status: taken.has(dose.id)
          ? "taken"
          : skipped.has(dose.id)
            ? "skipped"
            : "pending",
      },
    });
  }
  rows.sort((a, b) => compareSortHint(a.key, b.key));
  return {
    date: ctx.date,
    entries: rows.slice(0, MAX_SNAPSHOT_DOSES).map((r) => r.entry),
  };
}

// ── medication-list ──────────────────────────────────────────────────────────

function buildMedicationListData(
  ctx: SnapshotContext
): SnapshotDataByKind["medication-list"] {
  const doses = getIntakeDoses(ctx.profileId);
  const dosesByItem = new Map<number, typeof doses>();
  for (const d of doses) {
    const list = dosesByItem.get(d.item_id);
    if (list) list.push(d);
    else dosesByItem.set(d.item_id, [d]);
  }
  const coursesByItem = new Map<
    number,
    ReturnType<typeof getMedicationCourses>
  >();
  for (const c of getMedicationCourses(ctx.profileId)) {
    const list = coursesByItem.get(c.item_id);
    if (list) list.push(c);
    else coursesByItem.set(c.item_id, [c]);
  }
  const rows = buildMedicationList(
    getIntakeItems(ctx.profileId)
      .filter((i) => i.active === 1)
      .map((item) => {
        const own = dosesByItem.get(item.id) ?? [];
        return {
          id: item.id,
          name: item.name,
          brand: item.brand,
          product: item.product,
          asNeeded: isOnDemand(item),
          rx: item.rx === 1,
          prescriber: item.prescriber,
          doseAmounts: own.map((d) => d.amount).filter((a): a is string => !!a),
          timesOfDay: own.map((d) => d.time_of_day),
          startedOn: medicationStartDate(
            coursesByItem.get(item.id) ?? [],
            item.created_at,
            ctx.timeZone
          ),
        };
      })
  );
  // PROJECTED, like every sibling builder (#2994 R4). `buildMedicationList` answers a
  // "bring your medication list" artifact and carries `prescriber`, `startedOn` and `rx`
  // with it; the offline card renders none of the three. Storing them would put a named
  // third party — someone's cardiologist — at rest on a device whose whole risk model is
  // "anyone holding the unlocked phone can read this", to be rendered by nothing. A field
  // earns its place in this payload by being on the screen.
  return {
    rows: rows
      .slice(0, MAX_SNAPSHOT_MEDICATIONS)
      .map(({ id, name, subtitle, dose, schedule }) => ({
        id,
        name,
        subtitle,
        dose,
        schedule,
      })),
  };
}

// ── recent-training ──────────────────────────────────────────────────────────

function buildRecentTraining(
  ctx: SnapshotContext
): SnapshotDataByKind["recent-training"] {
  const { weightUnit } = getUnitPrefs(ctx.loginId);
  const prefs = getDisplayFormatPrefs(ctx.loginId);
  // Pre-formatted server-side in the login's own units (#630's kg/km canonical storage
  // converted at THIS boundary, once): the offline renderer holds no unit preference
  // and must never guess one, so the payload carries display strings, not raw loads.
  const recent = getRecentByExercise(
    ctx.profileId,
    weightUnit,
    prefs,
    MAX_SNAPSHOT_SESSIONS
  );
  const exercises = Object.entries(recent)
    .map(([exercise, sessions]) => ({
      exercise,
      sessions: sessions.slice(0, MAX_SNAPSHOT_SESSIONS).map((s) => ({
        date: s.date,
        equipment: s.equipment,
        text: s.text,
      })),
    }))
    // Most-recently-trained movements first, and CAPPED: exercise history is the one
    // read here that grows without bound, so "last N per exercise" needs a bound on
    // the exercises too or the payload tracks the whole training career.
    .filter((e) => e.sessions.length > 0)
    .sort((a, b) => b.sessions[0].date.localeCompare(a.sessions[0].date))
    .slice(0, MAX_SNAPSHOT_EXERCISES);

  const activities = getActivities(ctx.profileId, MAX_SNAPSHOT_ACTIVITIES).map(
    (a) => ({
      date: a.date,
      title: a.title,
      detail: a.type,
    })
  );
  return { activities, exercises };
}

// ── food-tallies ─────────────────────────────────────────────────────────────

function buildFoodTallies(
  ctx: SnapshotContext
): SnapshotDataByKind["food-tallies"] {
  const servings = getFoodServingsOnDate(ctx.profileId, ctx.date);
  const groups = [...servings.entries()]
    .filter(([, n]) => n > 0)
    .map(([key, n]) => ({
      key,
      name: foodGroupBySlug(key)?.name ?? key,
      servings: n,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SNAPSHOT_FOOD_GROUPS)
    .map((g) => ({ key: g.key, label: g.name, servings: g.servings }));
  return {
    date: ctx.date,
    groups,
    // Null, not 0, for a profile that doesn't track protein: an absent number and a
    // logged zero are different facts, and the offline card renders them differently.
    proteinGrams: profileTracksProtein(ctx.profileId)
      ? getProteinDailyGrams(ctx.profileId, ctx.date)
      : null,
  };
}

// ── practice-week ────────────────────────────────────────────────────────────

function buildPracticeWeek(
  ctx: SnapshotContext
): SnapshotDataByKind["practice-week"] {
  const practices = getTrackedPractices(ctx.profileId, ctx.date)
    .slice(0, MAX_SNAPSHOT_PRACTICES)
    .map((p) => ({
      identity: p.identity,
      name: p.name,
      perWeek: p.perWeek,
      countThisWeek: p.countThisWeek,
      todayCount: p.todayCount,
    }));
  // `pace` and `atCeiling` are deliberately dropped: both are verdicts about a week
  // still in progress, and a frozen "behind pace" is exactly the misleading-when-stale
  // output decision 5 keeps off the device. The counts and the target ship; the reader
  // can see for themselves.
  return { date: ctx.date, practices };
}

// ── The one dispatch ─────────────────────────────────────────────────────────

const BUILDERS: {
  [K in SnapshotKind]: (ctx: SnapshotContext) => SnapshotDataByKind[K];
} = {
  "dose-schedule": buildDoseSchedule,
  "medication-list": buildMedicationListData,
  "recent-training": buildRecentTraining,
  "food-tallies": buildFoodTallies,
  "practice-week": buildPracticeWeek,
};

// Build one snapshot, wrapped in the profile-stamped envelope the device stores. Every
// payload carries `{profileId, timeZone, capturedOn, fetchedAt}` — the capture-time
// attribution (#599) that governs intents, extended to reads.
export function buildSnapshot<K extends SnapshotKind>(
  kind: K,
  ctx: SnapshotContext,
  now: Date
): AnySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind,
    profileId: ctx.profileId,
    timeZone: ctx.timeZone,
    capturedOn: ctx.date,
    fetchedAt: utcInstant(now),
    data: BUILDERS[kind](ctx),
  } as AnySnapshot;
}

// Build the requested kinds (default: all of them) for one profile.
export function buildSnapshots(
  ctx: SnapshotContext,
  now: Date,
  kinds: readonly SnapshotKind[] = SNAPSHOT_KINDS
): AnySnapshot[] {
  return kinds.map((kind) => buildSnapshot(kind, ctx, now));
}
