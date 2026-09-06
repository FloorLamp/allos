// THE HISTORY PAGE'S GATHER (issue #3958, phase 1) — the Logs family, as rows.
//
// `/history` absorbs four standalone ledger routes. This module is what made that
// possible without a fifth copy of "a dated log entry, newest first": every kind's
// rows come from the reader that ALREADY served its ledger, and what this file adds is
// only the per-kind COMPOSER — the two or three sentences that turn that domain's row
// into the shared `HistoryRow` shape. One grammar (lib/history-format.ts), many
// composers, each going through the domain formatter that already exists.
//
// THE COMPOSERS SIT BESIDE THEIR READ, deliberately: `doseRows` is the only place that
// knows a dose's detail is amount-then-product, and it is three lines below the call to
// `getIntakeDoseLedgerPage`. A shared "detail builder" that knew about all five kinds
// would be the switch statement the ledger shell was unpicked to remove.
//
// SCOPING. Every read here takes `profileId` first and is scoped by it in SQL; this
// module imports no auth. `?view=everyone` calls this function once PER MEMBER, so
// every visibility rule a member's own pages apply is inherited per row rather than
// re-derived across a widened query — which is what makes "the page cannot widen
// exposure beyond what each member's own pages show this login" a property of the
// composition rather than a promise.
//
// THE RECORD ENDS AT NOW. Rows dated after the subject's today are dropped here, not
// in the view: the timeline's future fold is NOT inherited, the future belongs to
// /upcoming, and a bound the renderer applies is a bound the count line can disagree
// with.

import { db, today } from "./db";
import { zonedDateParts } from "./date";
import { isMinor } from "./life-stage";
import {
  getDisplayFormatPrefs,
  getProfileAge,
  getTimezone,
  getUnitPrefs,
} from "./settings";
import { bestKnownInstant, eventInstant, recordInstant } from "./row-instants";
import { now } from "./clock";
import { getIntakeDoseLedgerPage } from "./queries";
import { getFoodLedgerPage } from "./queries/nutrition";
import { getPracticeLedgerPage } from "./queries/wellness";
import { getSubstanceLedgerPage } from "./queries/substance";
import { getBodyMetricsOnDate, getBodyMetricsPage } from "./queries/metrics";
import { bodyMetricMeasures } from "./body-metric-measures";
import { foodGroupBySlug } from "./food-groups";
import { foodEventWindow } from "./food-slot-count";
import type { FoodSlotBoundaries } from "./food-slot";
import { profileFoodSlotBoundaries } from "./profile-food-slot";
import { normalizePracticeName } from "./practice";
import { formatMinutes } from "./duration";
import { ALCOHOL_FOOD_GROUP, substanceDef } from "./substance-use";
import { historyHref, medicationHref, metricDetailHref } from "./hrefs";
import {
  detailSegment,
  historyClockFields,
  historyKindFamily,
  resolveHistoryItem,
  HISTORY_KINDS,
  type HistoryFamily,
  type HistoryKind,
  type HistoryRow,
} from "./history-format";
import type { MemberTimeline } from "./timeline-multi";
import { shiftDateStr } from "./date";
import { getSleepSessions, getSleepSessionsSince } from "./queries/metrics";
import { mainSleepPeriod } from "./sleep-regularity";
import { getIntegration } from "./integrations/registry";
import type { IntegrationId } from "./types/integrations";
import { getSymptomDaysInRange } from "./queries/symptoms";
import { getBristolRows } from "./queries/bristol-stool";
import { BRISTOL_STOOL_METRIC, bristolStoolType } from "./bristol-stool";
import { getSymptomPhotosInRange } from "./symptom-photo-write";
import { symptomLabel, severityLabelFor } from "./symptoms";
import { getMoodLogs, getMoodOnDate, hasMoodLogs } from "./queries/mood";
import { isAnxietyScaleRelevant } from "./queries/mood-anxiety";
import { MOOD_FACTORS, anxietyDisplaySlot, moodLabel } from "./mood";
import { listCyclePeriods } from "./cycle-store";
import { cycleDayOnDate, FLOW_LABELS, isFlowLevel } from "./cycle";
import { formatClockValue } from "./format-date";
import { getTimelineEvents, type TimelineEvent } from "./timeline";
import type { TimelineCategory } from "./timeline-format";

// A window with no lower bound. The record outlives retirement — a dose taken years
// ago still happened — so the floor is a floor, not a default range.
const ISO_FLOOR = "0001-01-01";
const MOOD_FACTOR_LABEL = new Map(
  MOOD_FACTORS.map((factor) => [factor.slug, factor.label])
);

export interface HistoryGatherOptions {
  /** The login whose display preferences format every clock on the page. */
  loginId: number;
  /** Narrow to one kind. Undefined = every kind the family allows. */
  kind?: HistoryKind;
  /** Narrow to one family. Ignored when `kind` is set — a kind implies its family. */
  family?: HistoryFamily;
  /** The dose two-door pre-filter the deleted routes used to encode as two paths. */
  doseClass?: "supplement" | "medication";
  /** The kind-scoped item axis: an intake item id, a food group slug, a practice, … */
  item?: string;
  /** Only rows carrying media (the Photos filter — a filter, never a renderer). */
  media?: boolean;
  /** One profile-local day, for the day view. */
  day?: string;
  /** The read's bound. Rows beyond it are what "Load more" reveals. */
  limit: number;
  /**
   * The profile the reader is ACTING AS, when this gather is one member's half of a
   * merged `?view=everyone` read (#4079). Rows gathered for anyone else then carry
   * destinations that name their own subject, because a record page resolves against
   * the acting profile unless the URL says otherwise. Omitted on a single-profile
   * read, where every row's subject is already the acting one.
   */
  actingProfileId?: number;
}

export interface HistoryGather {
  rows: HistoryRow[];
  /** Whether the bound cut anything off — the load-more control's whole predicate. */
  hasMore: boolean;
  /** The kinds this profile has ANY row for: what earns a filter chip (#3958). */
  presentKinds: HistoryKind[];
  /**
   * Whether `?media=1` actually narrowed anything. False when it was not asked for,
   * and false when it was asked for and no row could satisfy it — the degrade case,
   * which the page reads so the chip and the URL both stop claiming a filter is on.
   */
  mediaApplied: boolean;
  /** The subject's own today, in the subject's own timezone. */
  today: string;
  /**
   * THE DAY VIEW'S INTRADAY AXIS (#1068, inherited here with `/timeline`'s retirement).
   *
   * The feed events this gather actually EMITTED as rows on the requested day, and
   * empty on every other read — the panel is a day-view surface, so a scrolling feed
   * pays nothing for it. Handing the panel the resolved list rather than letting it
   * re-query is what makes "a tick can never name something the list below does not
   * show" true by construction; capturing at the emit point makes the converse true
   * too, because a row the reader's `?kind=` dropped never reaches this array.
   *
   * Ids are namespaced `feed:` exactly as the rows are, so `timelineEntryAnchorId`
   * resolves a tick onto the row element that represents the same event.
   *
   * NOTHING IS LOST relative to what `/timeline` drew: the categories this gather
   * reads natively instead (body, food, substance, symptom) are all clockless day
   * aggregates in lib/timeline.ts — no `sortTime`, so `clockMinute` returned null and
   * they contributed no tick there either. Measured, not assumed.
   *
   * PRACTICE IS THE EXCEPTION, and it is an ADDITION rather than a loss (#3142): a
   * practice session now states a window, and its rows push themselves onto this
   * array from the practice reader below. `/timeline` grouped a day's sessions into
   * one clockless card and could draw neither a block nor a tick for them; this page
   * lists them one per session, so each gets its own mark on its own anchor.
   */
  dayEvents: TimelineEvent[];
}

function wants(opts: HistoryGatherOptions, kind: HistoryKind): boolean {
  if (opts.kind != null) return opts.kind === kind;
  if (opts.family != null) return historyKindFamily(kind) === opts.family;
  return true;
}

// The local wall clock of a resolved instant, as the "HH:MM" the ordering contract
// compares and the clock grammar renders. A row with no instant at all returns null —
// a state, not a missing value, and the thing that sinks the row below the day's timed
// ones.
function localClock(tz: string, at: string): string | null {
  const parts = zonedDateParts(tz, new Date(at));
  return parts.hhmm || null;
}

/**
 * WHICH KINDS THIS PROFILE HAS ANY ROW FOR — what earns a filter chip (#3958).
 *
 * ASKED INDEPENDENTLY OF THE FILTER, which is the whole point and was the defect:
 * derived from the gather's own reads, a page filtered to Food reported only Food as
 * present, so the chip row COLLAPSED to "All · Food" and every kind→kind move cost two
 * taps through All. Presence is a fact about the profile, not about the view.
 *
 * Five indexed existence probes, not five gathers: this runs on every render of the
 * page and must not cost a second pass over the rows. The substance probe carries the
 * same life-stage gate the substance READ does — a chip is an offer, and the record
 * must not advertise what its gather will refuse (#1174/#1279).
 */
export function historyPresentKinds(profileId: number): HistoryKind[] {
  // ONE LITERAL STATEMENT PER KIND, and the repetition is the point — the scoping
  // scanner verifies `profile_id` in the literal SQL text of every prepared statement
  // over an owned table, and a helper taking the SQL as a parameter is one it cannot
  // read. `bodyMetricSelect` in lib/metric-readings.ts makes the same trade in the
  // same layer, for the same reason: a scannable statement beats a clever one where
  // the question is whose rows you see.
  const out: HistoryKind[] = [];
  const dose = db
    .prepare(
      `SELECT 1 FROM intake_item_logs l JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.status = 'taken' LIMIT 1`
    )
    .get(profileId);
  if (dose != null) out.push("dose");
  // The SAME exclusion the food read applies (see the food composer): a profile whose
  // only servings are drinks has no food rows on the record, and a chip that opened
  // onto nothing would be the presence rule saying the opposite of what it means.
  const food = db
    .prepare(
      `SELECT 1 FROM food_log_events
        WHERE profile_id = ? AND substr(group_key, 1, 2) != '__'
          AND group_key != ? LIMIT 1`
    )
    .get(profileId, ALCOHOL_FOOD_GROUP);
  if (food != null) out.push("food");
  const practice = db
    .prepare("SELECT 1 FROM practice_logs WHERE profile_id = ? LIMIT 1")
    .get(profileId);
  if (practice != null) out.push("practice");
  if (hasMoodLogs(profileId)) out.push("mood");
  // THE PROBE READS WHAT THE ROWS READ (#5026 phase 2), which is the food probe's own
  // rule three lines up: both consumable ledgers are EVENT tables now, so a chip is
  // earned by a use that exists rather than by a counter that says one did. Asking the
  // counters instead would earn the chip for a day row with no events under it, and the
  // chip would open onto nothing — the presence rule saying the opposite of what it
  // means. Two reads because there are two stores, and alcohol's is the food one.
  if (!isMinor(getProfileAge(profileId))) {
    const drink = db
      .prepare(
        `SELECT 1 FROM food_log_events
          WHERE profile_id = ? AND group_key = ? LIMIT 1`
      )
      .get(profileId, ALCOHOL_FOOD_GROUP);
    const use = db
      .prepare(
        "SELECT 1 FROM substance_log_events WHERE profile_id = ? LIMIT 1"
      )
      .get(profileId);
    if (drink != null || use != null) out.push("substance");
  }
  const body = db
    .prepare("SELECT 1 FROM body_metrics WHERE profile_id = ? LIMIT 1")
    .get(profileId);
  if (body != null) out.push("body");
  // SLEEP IS A `metric_samples` KIND, so the probe names the metric as well as the
  // profile — the table holds every sampled measure and a bare profile probe would
  // earn the Sleep chip for a profile that has only ever synced steps. The window
  // predicate is the one `readSleepSessions` applies: a row whose end is not after its
  // start is not a session, and the gather drops it, so a chip earned on one would open
  // onto nothing.
  const sleep = db
    .prepare(
      `SELECT 1 FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          AND julianday(ended_at) > julianday(started_at) LIMIT 1`
    )
    .get(profileId);
  if (sleep != null) out.push("sleep");
  const symptom = db
    .prepare("SELECT 1 FROM symptom_logs WHERE profile_id = ? LIMIT 1")
    .get(profileId);
  if (symptom != null) out.push("symptom");
  // STOOL IS A `metric_samples` KIND, so the probe names the metric as well as the
  // profile — the same reason sleep's does one block up.
  const stool = db
    .prepare(
      "SELECT 1 FROM metric_samples WHERE profile_id = ? AND metric = ? LIMIT 1"
    )
    .get(profileId, BRISTOL_STOOL_METRIC);
  if (stool != null) out.push("stool");
  const cycle = db
    .prepare("SELECT 1 FROM cycles WHERE profile_id = ? LIMIT 1")
    .get(profileId);
  if (cycle != null) out.push("cycle");
  return out;
}

// THE 21 TIMELINE CATEGORIES, REGROUPED INTO THE CLOSED KIND REGISTRY (#3958 phase 2).
//
// This is the whole of "lib/timeline.ts moves essentially unchanged — a re-housing, not
// a rewrite": the feed's gather is left where it is and this says which family each of
// its categories lands in. Total over `TimelineCategory`, so a new category is a TYPE
// error here rather than an event that silently never renders.
//
// FIVE MAP TO `null`, AND THAT IS THE POINT. body, food, substance, practice and
// symptom are Logs kinds with their own composers above — reading them from both
// gathers would put one act on the record twice, which is the same double-count the
// drink ruling settled for food and substances. The timeline's own symptom entry is a
// DAY AGGREGATE besides ("3 symptoms logged"); the record's symptom rows are the
// entries themselves.
type FeedRule = readonly [HistoryKind | null, "event" | "plain"];
const FEED_RULE: Record<TimelineCategory, FeedRule> = {
  activity: ["activity", "event"],
  endurance: ["endurance", "plain"],
  milestone: ["milestone", "event"],
  medical: ["lab", "event"],
  visit: ["visit", "event"],
  imaging: ["imaging", "plain"],
  medication: ["medication", "plain"],
  immunization: ["immunization", "event"],
  condition: ["condition", "plain"],
  allergy: ["allergy", "plain"],
  document: ["document", "event"],
  protocol: ["protocol", "event"],
  goal: ["goal", "plain"],
  illness: ["illness", "event"],
  injury: ["injury", "plain"],
  insight: ["insight", "plain"],
  body: [null, "plain"],
  food: [null, "plain"],
  substance: [null, "plain"],
  practice: [null, "plain"],
  symptom: [null, "plain"],
};

// WHOSE CLOCK A FEED EVENT'S `sortTime` IS. One category states a real event time
// (`activities.start_time`); every other one that carries a clock at all derives it
// from `created_at` through `timeFromCreatedAt`, i.e. a FILING time. The page has one
// clock grammar and it distinguishes the two — "6:41am" against "logged 6:41am" — so
// this answers it from the category rather than printing a filing stamp as if the visit
// had happened then (#2228 decision 4).
function feedClockKind(category: TimelineCategory): "stated" | "logged" {
  return category === "activity" ? "stated" : "logged";
}

/**
 * EVERY LOGS ROW ONE PROFILE RECORDED, newest first, bounded by `limit`.
 *
 * Each kind is read to the same bound and the five lists are merged by the caller's
 * ordering (`mergeMemberTimelines`), so no kind can crowd another out of the top of
 * the page: a day of forty servings still leaves that day's lab visible.
 */
export function gatherHistoryLog(
  profileId: number,
  opts: HistoryGatherOptions
): HistoryGather {
  const todayStr = today(profileId);
  const tz = getTimezone(profileId);
  const prefs = getDisplayFormatPrefs(opts.loginId);
  const units = getUnitPrefs(opts.loginId);
  const until = opts.day ?? todayStr;
  const since = opts.day ?? ISO_FLOOR;
  const limit = Math.max(1, Math.trunc(opts.limit));
  // AN ITEM THAT CANNOT MATCH DEGRADES TO THE KIND, the way an invalid `?kind` or
  // `?family` degrades to All: "a bad deep link degrades to the page, never a 404",
  // and an empty page asserting there is nothing is the same failure wearing a 200.
  // The two axes with a CLOSED vocabulary are checked here — a food group that is not
  // a food group (`?item=alcohol` became one the moment the record ruled a drink a
  // substance) and a body measure that is not one of the three. Dose items and
  // practices have OPEN vocabularies whose membership is a per-profile question, so
  // they are left to their readers, which return nothing for an unknown one; that is
  // the same empty page and it is recorded in the report rather than papered over.
  const item = resolveHistoryItem(opts.kind, opts.item);
  const rows: HistoryRow[] = [];
  const dayEvents: TimelineEvent[] = [];
  let truncated = false;
  // The SUBJECT's meal-bucket boundaries, read at most once. Two composers need them —
  // the servings and the drinks, which are the same ledger asked two ways — and a
  // reader that wants neither must not pay for the read.
  let boundariesMemo: FoodSlotBoundaries | null = null;
  const slotBoundaries = (): FoodSlotBoundaries =>
    (boundariesMemo ??= profileFoodSlotBoundaries(profileId));

  // ── DOSES ────────────────────────────────────────────────────────────────
  // The cross-item dose ledger's own reader (#2445), asked for one page the size of
  // the page's bound. `class` is the pre-filter the two deleted routes encoded as two
  // paths; here it is a param on one page, exactly as `?kind=dose&class=medication`.
  if (wants(opts, "dose")) {
    const itemId = Number(item);
    const ledger = getIntakeDoseLedgerPage(
      profileId,
      since,
      {
        kind: opts.doseClass,
        itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : undefined,
        untilDate: until,
      },
      1,
      limit
    );
    if (ledger.total > ledger.rows.length) truncated = true;
    for (const row of ledger.rows) {
      // The row-level time question, asked once (#2205 phase 3): the stated
      // administration instant when somebody named one, else the record chain — with
      // the answer saying WHICH, so a filing timestamp is never printed as if the dose
      // had been given then (#2228 decision 4).
      const when = bestKnownInstant("intake_item_logs", { ...row });
      const hhmm = when.known ? localClock(tz, when.at) : null;
      const stated = when.known && when.semantic === "event";
      rows.push({
        id: `dose:${row.id}`,
        kind: "dose",
        profileId,
        tz,
        date: row.date,
        ...historyClockFields(hhmm, stated ? "stated" : "logged", prefs),
        title: row.item_name,
        // A MEDICATION HAS A HOME AND A SUPPLEMENT DOES NOT (#4045 §5, extended).
        // The title link is a PER-ITEM question — "does this thing have a home" — and
        // `medicationHref` answers it with that item's own page. The supplement arm
        // answered `intakeHref("supplement")` for EVERY supplement row: one page-level
        // destination repeated down the column, which is the same shape the substance
        // rows lost below and fails the issue's own criterion ("no row title links to a
        // destination shared by every row of its kind") for a kind it did not happen to
        // enumerate. Plain until the supplements surface exposes a per-item anchor; a
        // page-level link is not a fallback for a missing home.
        href:
          row.item_kind === "medication" ? medicationHref(row.item_id) : null,
        // quantity → context: the amount taken, then the product it came out of.
        detail: detailSegment([row.amount, row.product]),
        media: 0,
        edit: {
          kind: "dose",
          logId: row.id,
          itemId: row.item_id,
          doseId: row.dose_id,
          statedAt: row.occurred_at,
          amount: row.amount,
          itemKind:
            row.item_kind === "medication" ? "medication" : "supplement",
        },
      });
    }
  }

  // ── FOOD ─────────────────────────────────────────────────────────────────
  //
  // A DRINK IS ONE RECORD, AND IT IS A SUBSTANCE ONE (owner ruling, 2026-08-29).
  // #860/#944 put a standard drink on the food store because a drink IS one serving
  // of the curated `alcohol` group — a STORAGE decision, documented as one in
  // lib/queries/substance.ts, and not a claim that a drink is a meal. Reading both
  // stores put the same drink on the record twice: a `food` row saying "Alcohol ·
  // Evening" and a `substance` row saying "Alcohol · 1 standard drink", so the day
  // header counted "2 records" for one act. Three reasons decide which one goes, in
  // the order that decides it:
  //
  //   1. THE AGE GATE. The substance kind is gated on `isMinor` below; the food kind
  //      is not, and correctly is not — food is gated nowhere. MEASURED, not assumed:
  //      before this line, a known minor's `?kind=food` returned that drink as a row
  //      titled "Alcohol" while `?kind=substance` correctly returned nothing. The
  //      gate was decorative for exactly the rows it exists to cover.
  //   2. The record's day count is a count of things that HAPPENED, and one drink is
  //      one thing. AMENDED 2026-09-04 (see the substances block below): the thing is
  //      the EVENT, so the count is derived from the events rather than read off a day
  //      total. The reason still decides where a drink is FILED, which is all it is
  //      doing here; what it no longer decides is that the day is one row.
  //   3. The substance row describes the act in the person's own terms ("1 standard
  //      drink") rather than as a serving of a food group.
  //
  // THE DRINK DOES NOT DISAPPEAR, and that was checked rather than reasoned: the
  // food door writes the `food_daily_totals` counter as well as the event
  // (lib/food-log-write.ts keeps them as one fact in two shapes). Since 2026-09-04 the
  // substances block reads the EVENT it wrote rather than the counter beside it, so a
  // serving logged through Nutrition still reaches the record, once, as a substance —
  // and now as the row for that one serving. Food TOTALS are untouched: this is the
  // record's row set, not the nutrition arithmetic, and the counter is still the cap's
  // substrate and the substance card's count.
  //
  // …EXCEPT FOR A KNOWN MINOR, WHERE IT DISAPPEARS — AN OPEN OWNER QUESTION (#4072).
  // The substance gate below does not run for one, and this exclusion is unconditional,
  // so such a row is on NEITHER half while still counting in
  // `getAllSubstanceDailyTotals`. That is the ruling above working exactly as measured,
  // and it is a row nobody can undo from the surface that would undo it; the two
  // readings want opposite code, so the exclusion stays as the ruling set it and this
  // change stops the record CREATING the state instead.
  //
  // ONE EXPRESSION for "does this subject's record carry substance content at all",
  // read by that gate and by the correction's offer, so the record cannot show a group
  // it would then refuse to write.
  const substanceShown = !isMinor(getProfileAge(profileId));
  if (wants(opts, "food")) {
    const ledger = getFoodLedgerPage(
      profileId,
      since,
      {
        untilDate: until,
        groupKey: item,
        excludeAlcohol: true,
      },
      1,
      limit
    );
    if (ledger.total > ledger.rows.length) truncated = true;
    for (const row of ledger.rows) {
      const when = bestKnownInstant("food_log_events", { ...row });
      const hhmm = when.known ? localClock(tz, when.at) : null;
      const stated = when.known && when.semantic === "event";
      rows.push({
        id: `food:${row.id}`,
        kind: "food",
        profileId,
        tz,
        date: row.date,
        ...historyClockFields(hhmm, stated ? "stated" : "logged", prefs),
        // Identity is the FOOD at this scope (#3937): a day of servings differs by
        // what was eaten, not by the date every one of them shares.
        title: foodGroupBySlug(row.group_key)?.name ?? row.group_key,
        // Food groups have no page of their own, so the title stays plain text —
        // the title link answers "does this thing have a home", and this one does not.
        href: null,
        detail: detailSegment([
          foodEventWindow(
            row.recorded_at,
            tz,
            slotBoundaries(),
            row.meal_slot,
            row.occurred_at
          ),
        ]),
        media: 0,
        edit: {
          kind: "food",
          eventId: row.id,
          groupKey: row.group_key,
          mealSlot: foodEventWindow(
            row.recorded_at,
            tz,
            slotBoundaries(),
            row.meal_slot,
            row.occurred_at
          ),
          clock: hhmm,
          clockKind: stated ? "stated" : "logged",
          slotBoundaries: slotBoundaries(),
          substanceCorrectable: substanceShown,
        },
      });
    }
  }

  // ── PRACTICES ────────────────────────────────────────────────────────────
  if (wants(opts, "practice")) {
    const ledger = getPracticeLedgerPage(
      profileId,
      since,
      { untilDate: until, practice: item },
      1,
      limit
    );
    if (ledger.total > ledger.rows.length) truncated = true;
    for (const row of ledger.rows) {
      // A quick-path tick records no clock at all (#2205): the row has no event
      // instant, and `practice_logs` carries `created_at` as its record stamp, so the
      // fallback says "logged" rather than pretending a session time.
      const when = bestKnownInstant("practice_logs", { ...row }, tz);
      const hhmm = when.known ? localClock(tz, when.at) : null;
      const stated = when.known && when.semantic === "event";
      rows.push({
        id: `practice:${row.id}`,
        kind: "practice",
        profileId,
        tz,
        date: row.date,
        ...historyClockFields(hhmm, stated ? "stated" : "logged", prefs),
        title: normalizePracticeName(row.practice),
        href: null,
        // quantity → context → source, source always the muted tail.
        detail: detailSegment([
          row.duration_min != null ? formatMinutes(row.duration_min) : null,
          row.notes,
          row.source,
        ]),
        media: 0,
        edit: {
          kind: "practice",
          sessionId: row.id,
          // The correction form REWRITES every field the action reads, so the row
          // carries what it must post back unchanged — and `start_time` is the
          // STORED column, not the resolved instant above it. `hhmm` may be the
          // record chain's minute; this never is.
          statedStart: row.start_time,
          statedEnd: row.end_time,
          durationMin: row.duration_min,
          notes: row.notes,
        },
      });
      // THE SESSION'S WINDOW, ONTO THE DAY'S CHART (#3142). Practices reach this page
      // as one row PER SESSION, so each session is its own event with its own anchor
      // — the `practice:<id>` id is the ROW's id, which is what makes the block or
      // tick scroll to the row that represents it. Pushed HERE, beside the row it
      // came from, for the same reason the feed loop pushes at its emit point: a
      // session the reader's `?kind=` or `?item=` dropped never reaches this array,
      // so the panel cannot draw a mark for something the list below does not show.
      if (opts.day != null) {
        const started = recordInstant("practice_logs", { ...row });
        const elapsedMin =
          row.live === 1 && started.known
            ? Math.max(
                0,
                Math.round(
                  (now().getTime() - new Date(started.at).getTime()) / 60_000
                )
              )
            : null;
        dayEvents.push({
          id: `practice:${row.id}`,
          date: row.date,
          category: "practice",
          title: normalizePracticeName(row.practice),
          clockWindow: {
            date: row.date,
            start_time: row.start_time,
            end_time: row.end_time,
            duration_min: row.duration_min,
            live: row.live === 1,
            derived_duration: row.derived_window === 1,
            elapsed_min: elapsedMin,
          },
        });
      }
    }
  }

  // ── MOOD ────────────────────────────────────────────────────────────────
  // ONE ROW PER PROFILE-LOCAL DAY. A check-in states no instant (#992), so it is a
  // date-only record and its full statement stays together: valence, the optional
  // Energy and Calm scales, factors and note. The same row payload seeds MoodForm;
  // none of those fields is carried through a valence-only correction any more.
  if (wants(opts, "mood")) {
    const moodRows = opts.day
      ? [getMoodOnDate(profileId, opts.day)].filter((row) => row != null)
      : getMoodLogs(profileId, since === ISO_FLOOR ? undefined : since)
          .filter((row) => row.date <= until)
          .reverse();
    if (moodRows.length > limit) truncated = true;
    const calmRelevant =
      moodRows.length > 0 && isAnxietyScaleRelevant(profileId);
    for (const row of moodRows.slice(0, limit)) {
      rows.push({
        id: `mood:${row.id}`,
        kind: "mood",
        profileId,
        tz,
        date: row.date,
        ...historyClockFields(null, "logged", prefs),
        title: "Mood",
        href: metricDetailHref("mood"),
        detail: detailSegment([
          `${moodLabel(row.valence)} (${row.valence}/5)`,
          row.energy == null ? null : `Energy ${row.energy}/5`,
          row.anxiety == null
            ? null
            : `Calm ${anxietyDisplaySlot(row.anxiety)}/5`,
          row.factors
            .map((factor) => MOOD_FACTOR_LABEL.get(factor) ?? factor)
            .join(", "),
          row.notes,
        ]),
        media: 0,
        edit: {
          kind: "mood",
          target: `mood:${row.id}:valence`,
          valence: row.valence,
          energy: row.energy,
          anxiety: row.anxiety,
          factors: row.factors,
          notes: row.notes,
          calmRelevant,
        },
      });
    }
  }

  // ── SUBSTANCES ───────────────────────────────────────────────────────────
  // LIFE-STAGE GATED, exactly as the surface that owns them is (#1174/#1279): the
  // substance record is adult-only content, and a page that merged it in for a known
  // minor would be widening exposure past what that profile's own pages show. Asked of
  // the SUBJECT's age, so `?view=everyone` inherits the gate per member — and it is the
  // same `substanceShown` the food correction's offer reads (#4072).
  //
  // A CONSUMABLE IS AN EVENT (owner ruling, 2026-09-04). A drink, like a serving and
  // like a dose, is a thing that happened at an instant; the day total is a ROLLUP and
  // not the editable thing. That ruling AMENDS two of this file's own: "a day's drinks
  // are one editable day count" and "the day count is a count of things that happened"
  // — the count is now DERIVED from the events, and a day with drinks at 21:00 and
  // 23:00 shows two rows and two ticks.
  //
  // IT AMENDS NEITHER OF THE OTHER TWO, which is why a drink is still filed here and
  // not under Food. The age gate above is the first (a known minor's `?kind=food`
  // returned that drink as a row titled "Alcohol" — MEASURED, and the reason the
  // exclusion was written), and "the substance row describes the act in the person's
  // own terms" is the third. So the drink keeps the `substance` KIND, its chip, its
  // glyph and its gate; what changes is that it is one row per EVENT, and that it
  // CORRECTS through the food serving's own form — `edit.kind` is the correction door,
  // `kind` is what the thing is, and the ruling asks for exactly that split.
  if (wants(opts, "substance") && substanceShown) {
    // DRINKS, ONE ROW PER EVENT, through the reader that already serves this ledger.
    // `getFoodLedgerPage` is the food gather's own reader asked for the one group the
    // food gather excludes, so there is no second query shape and no second idea of
    // what a serving row is. Alcohol is the only substance THIS loop reads:
    // `substanceDef(key).ledger` is `food-log` for alcohol and `substance-log` for
    // nicotine, cannabis and every custom key, and `nicotine`/`cannabis` are not food
    // groups at all, so nothing else can reach this branch. Every other substance is
    // one row per event too since #5026 phase 2, off its own ledger, in the loop below.
    if (!item || item === "alcohol") {
      const def = substanceDef("alcohol");
      const drinks = getFoodLedgerPage(
        profileId,
        since,
        { untilDate: until, groupKey: ALCOHOL_FOOD_GROUP },
        1,
        limit
      );
      if (drinks.total > drinks.rows.length) truncated = true;
      for (const row of drinks.rows) {
        // The same question the food row asks of the same table (#2205 phase 3): the
        // stated drinking instant when somebody named one, else the record chain —
        // with the answer saying WHICH, so a tap stamp never prints as a stated hour.
        const when = bestKnownInstant("food_log_events", { ...row });
        const hhmm = when.known ? localClock(tz, when.at) : null;
        const stated = when.known && when.semantic === "event";
        // THE ROW'S CLOCK AND THE RAIL'S MINUTE ARE DIFFERENT QUESTIONS, and this file
        // already ruled on it once — see the practice loop above, which places its own
        // ticks rather than leaving them to the rail for exactly this reason. The ROW
        // may say "logged 23:50", because the grammar's `logged` prefix admits that the
        // clock is a filing time and a serving row says the same thing beside it. The
        // CHART may not: a drink backfilled at 23:50 for last Tuesday would draw on
        // Tuesday's rail at a minute that describes the typing and nothing else, which
        // is the whole argument `EXCLUDED_TICK_CATEGORIES` makes about an insight's
        // `created_at`. So the mark reads the EVENT instant only — a time somebody
        // stated, or a tap that claimed to be one — and a drink with neither draws
        // nothing.
        const drankAt = eventInstant("food_log_events", { ...row });
        const markMinute = drankAt.known ? localClock(tz, drankAt.at) : null;
        const id = `substance:alcohol:${row.id}`;
        rows.push({
          id,
          kind: "substance",
          profileId,
          tz,
          date: row.date,
          ...historyClockFields(hhmm, stated ? "stated" : "logged", prefs),
          title: def.label,
          href: null,
          // ONE EVENT IS ONE UNIT. The day's arithmetic moved to the rows, so the
          // detail states the act rather than a total the row no longer owns.
          detail: detailSegment([`1 ${def.countSingular}`]),
          media: 0,
          // CORRECTED WHERE A SERVING IS CORRECTED (the ruling's question 1). This is
          // the food row's own edit payload, so `HistoryRows` mounts `FoodServingForm`
          // and the ⋯ delete runs `removeFoodServing` on this event — re-time, re-file
          // and delete, all already built, and `correctionGroups` already keeps a row
          // that is IN a substance group able to name its own group.
          edit: {
            kind: "food",
            eventId: row.id,
            groupKey: row.group_key,
            mealSlot: foodEventWindow(
              row.recorded_at,
              tz,
              slotBoundaries(),
              row.meal_slot,
              row.occurred_at
            ),
            clock: hhmm,
            clockKind: stated ? "stated" : "logged",
            slotBoundaries: slotBoundaries(),
            substanceCorrectable: substanceShown,
          },
        });
        // THE DRINK, ONTO THE DAY'S CHART. Pushed HERE, beside the row it came from
        // and with the SAME id, for the reason the practice and feed loops push at
        // their emit points: a row this reader's `?kind=`/`?item=` dropped never
        // reaches the array, so the panel cannot mark something the list does not
        // show, and a tick's anchor is the row it scrolls to.
        //
        // CATEGORY `substance`, MATCHING THE ROW'S KIND. The rail is category-driven
        // and drops only `insight`, so what this field decides is what the mark READS
        // as — and a drink arriving as `food` would read as a meal on the chart. It is
        // asserted, not assumed: the row and the tick answer "what is this" the same
        // way, and only `edit.kind` names the food door.
        //
        // DATA-GATED. `buildIntradayModel` draws a tick only where `sortTime` is a
        // real clock minute, so a drink nobody stated a time for contributes nothing —
        // the same rule that keeps a weigh-in and a day's dose roll-up off the rail.
        if (opts.day != null) {
          dayEvents.push({
            id,
            date: row.date,
            category: "substance",
            title: def.label,
            sortTime: markMinute,
          });
        }
      }
    }

    // EVERY OTHER SUBSTANCE, ALSO ONE ROW PER EVENT (#5026 phase 2). Nicotine,
    // cannabis and every custom key ride `substance_log_events` now, so this loop is
    // the drinks loop above with its own ledger and its own correction door: the same
    // instant questions, the same data-gated tick, the same "one event is one unit"
    // detail. What it replaces was a DAY row — date-only, sinking below the day's timed
    // rows, correcting through a day-count form — because `substance_daily_totals`
    // declares no event column and reading `bestKnownInstant` off it would have handed
    // a day a minute it never claimed. The events answer that question honestly now.
    const uses = getSubstanceLedgerPage(
      profileId,
      since,
      { untilDate: until, substance: item },
      1,
      limit
    );
    if (uses.total > uses.rows.length) truncated = true;
    for (const row of uses.rows) {
      const def = substanceDef(row.substance);
      // The stated use instant when somebody named one, else the record chain — with
      // the answer saying WHICH, so a tap stamp never prints as a stated hour.
      const when = bestKnownInstant("substance_log_events", { ...row });
      const hhmm = when.known ? localClock(tz, when.at) : null;
      const stated = when.known && when.semantic === "event";
      // THE ROW'S CLOCK AND THE RAIL'S MINUTE ARE DIFFERENT QUESTIONS, exactly as they
      // are for the drink above: the row may say "logged 23:50" because the grammar's
      // `logged` prefix admits a filing time, and the CHART may not, so the mark reads
      // the EVENT instant only and a use with none draws nothing. Every row the phase-2
      // backfill derived from a day count is in that state, which is why converting a
      // legacy day adds rows to the record and no ticks to the rail.
      const usedAt = eventInstant("substance_log_events", { ...row });
      const markMinute = usedAt.known ? localClock(tz, usedAt.at) : null;
      const id = `substance:${row.substance}:${row.id}`;
      rows.push({
        id,
        kind: "substance",
        profileId,
        tz,
        date: row.date,
        ...historyClockFields(hhmm, stated ? "stated" : "logged", prefs),
        title: def.label,
        // PLAIN, LIKE THE FOOD GROUPS BESIDE IT (#4045 §5). The title link is a
        // PER-ITEM question — "does this thing have a home" — and a substance has
        // none: the substance-use page renders per-substance cards but exposes no
        // anchor to one, so every row here would have linked to the same page-level
        // destination. That is an ad wearing a home's clothes. If a substance card
        // ever gains a stable per-item anchor the title may link THERE; the
        // page-level link is not a fallback for a missing one.
        href: null,
        // ONE EVENT IS ONE UNIT, the drink's own detail. The day's arithmetic moved to
        // the rows; the day's NOTE stayed on the day, so it is not repeated here once
        // per use (#5077 owns where a day note lives now).
        detail: detailSegment([`1 ${def.countSingular}`]),
        media: 0,
        edit: {
          kind: "substance",
          eventId: row.id,
          substance: row.substance,
          // The row's OWN stated instant, never `sortTime` — the practice row's rule
          // (#2205's substitution), because the correction rewrites what it reads and
          // posting a filing stamp back would stamp it into the event column.
          statedAt: row.occurred_at,
        },
      });
      if (opts.day != null) {
        dayEvents.push({
          id,
          date: row.date,
          category: "substance",
          title: def.label,
          sortTime: markMinute,
        });
      }
    }
  }

  // ── BODY ─────────────────────────────────────────────────────────────────
  // The readings `MetricReadingsTable` shows on the three body-composition detail
  // pages, re-housed (#3958 phase 1). The detail page KEEPS its bounded recent window
  // (#3505) — this is the cross-metric record, not a second copy of that panel.
  //
  // `metric_samples` AND THE LAB-SHAPED VITALS ARE NOT HERE, and that is the issue's
  // own ruling rather than an omission: "streams are not events" puts the sampled
  // measures on charts, and `medical_records` vitals are Clinical, i.e. phase 2.
  //
  // ONE ROW PER MEASURE, not per stored row: `body_metrics` is one row per day holding
  // up to three quantities, and a reader looking for "when did I last take my resting
  // HR" is asking about a measure. `bodyMetricMeasures` IS that fan-out, and this
  // reads it rather than re-deriving one. It carries the piece a hand-rolled copy got
  // wrong twice over: the value it hands back is already in the login's DISPLAY unit,
  // which is what `updateMetricReading` converts back from (#630/#3853). A parallel
  // array here printed `dispWeight` in the detail while seeding the edit field from
  // the STORED kilograms and posting `weight_unit: lb` beside them, so a row reading
  // "154.3 lb" opened its editor on 70 and saving it unchanged rewrote the record to
  // 31.75 kg. One shape, one conversion, one place.
  if (wants(opts, "body")) {
    // The shared readers, not a fourth SELECT on this table: the day view asks the
    // day question and the record asks for a page. Both are profile-scoped in SQL.
    // THE DATE BOUND IS IN SQL, like every other kind's. It used to be a predicate on
    // a raw SELECT here; moving to the shared reader dropped it, so "the record ends
    // at now" ran AFTER rows had been counted against the bound and a future-dated
    // row consumed a slot. lib/ingest-bounds.ts admits instants up to 24h ahead for
    // device clock skew, so tomorrow-dated body rows are an ordinary sync outcome
    // rather than a hypothetical.
    const bodyRows = opts.day
      ? getBodyMetricsOnDate(profileId, opts.day)
      : getBodyMetricsPage(profileId, 1, limit + 1, until).rows;

    // TRUNCATION IS ASKED IN BOTH UNITS, BECAUSE THE READ AND THE RENDER ARE BOUNDED
    // IN DIFFERENT ONES AND EITHER CAN BE THE ONE THAT CUT.
    //
    // The read is bounded in STORED rows; the page is bounded in RENDERED rows; and a
    // `body_metrics` row fans out to up to three measures while `?item=` narrows back
    // to one — in memory, because the measure lives in a column rather than a row.
    // Counting only the render was a withholding bug of exactly the family it
    // replaced: `?kind=body&item=resting-hr` over a store whose newest `limit` rows
    // carry no resting HR emitted nothing, reported `hasMore: false`, and asserted
    // completeness over readings a single "Load more" used to reach.
    //
    // So both questions are asked and the answers are OR'd. The read was cut when it
    // returned more rows than the bound; the render was cut when it stopped with rows
    // still to emit. Neither alone is "is there more"; together they cannot answer
    // "no" while there is.
    if (bodyRows.length > limit) truncated = true;
    let bodyEmitted = 0;
    for (const row of bodyRows.slice(0, limit)) {
      if (bodyEmitted >= limit) {
        truncated = true;
        break;
      }
      const when = bestKnownInstant("body_metrics", { ...row });
      const hhmm = when.known ? localClock(tz, when.at) : null;
      for (const measure of bodyMetricMeasures(row, units.weightUnit)) {
        if (item && item !== measure.slug) continue;
        if (bodyEmitted >= limit) {
          truncated = true;
          break;
        }
        bodyEmitted += 1;
        rows.push({
          id: `body:${measure.column}:${row.id}`,
          kind: "body",
          profileId,
          tz,
          date: row.date,
          // `body_metrics` has no record stamp at all, so an unstated reading is
          // genuinely date-only rather than falling back to a filing time.
          ...historyClockFields(hhmm, "stated", prefs),
          title: measure.label,
          href: metricDetailHref(measure.slug),
          // The SAME number the editor opens on, formatted once — the detail and the
          // edit field cannot disagree because there is only one value between them.
          // THE LABEL, NOT THE TOKEN. Both body readers compute `source_label` — the
          // integration's name, "Manual", "Document" — and reading `source` past it
          // printed a synced row as "71 kg · health_connect" where Trends prints
          // "Health Connect". Gated on the raw column so a MANUAL row still prints
          // nothing: the source is the muted tail when it says something, and
          // "Manual" on every hand-entered row is noise, not provenance.
          detail: detailSegment([
            `${measure.value}${measure.unit}`,
            row.source ? row.source_label : null,
          ]),
          media: 0,
          edit: {
            kind: "body",
            target: measure.target,
            slug: measure.slug,
            value: measure.value,
            // The unit the row PRINTED, posted with the correction so the action
            // converts by that rather than by the pref re-read at write time.
            unit: measure.slug === "weight" ? units.weightUnit : "",
          },
        });
      }
    }
  }

  // ── SLEEP ────────────────────────────────────────────────────────────────
  //
  // FILED UNDER THE WAKE DAY, and that is the whole decision (#3958): a session that
  // starts 11:38pm on the 27th and ends 6:41am on the 28th is the 28th's sleep, because
  // that is the night the reader means when they open the 28th. So the day is the
  // profile-LOCAL calendar date of the session's END — `zonedDateParts(tz, end).date`,
  // the SAME anchor `mainSleepNights` and `buildNights` use — and `when` is the wake
  // instant, so the row sorts at the top of its day beside a 7am dose.
  //
  // ONE ANCHOR ROW PER WAKE DAY, through the canonical classifier rather than a fourth
  // opinion about what a night is: `mainSleepPeriod` merges co-equal fragments, drops
  // provider-labelled naps and hands back the representative session, which is where
  // the SOURCE lives. `mainSleepNights` is the same computation with the source
  // projected away, and the row needs it for the muted provenance tail — so the
  // grouping is spelled here and the decision is still the shared one.
  //
  // › AND NOT ⋯: an imported night is corrected at its source, never in this list. The
  // pointer is the row's own DAY VIEW, which is the surface #3958 names for the stages
  // and the intraday axis — a per-row destination, not the sleep hub repeated down the
  // column.
  if (wants(opts, "sleep")) {
    // A night's window STRADDLES midnight, so the read has to start a day early or the
    // day view drops the very session it exists to show: `metric_samples.date` is the
    // source's own wake-day stamp and can sit one day off the profile-local one.
    const sessions = opts.day
      ? getSleepSessionsSince(profileId, shiftDateStr(since, -1))
      : since !== ISO_FLOOR
        ? getSleepSessionsSince(profileId, shiftDateStr(since, -1))
        : getSleepSessions(profileId, limit);
    const byWakeDay = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const startMs = new Date(session.start).getTime();
      const endMs = new Date(session.end).getTime();
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs
      )
        continue;
      const wakeDay = zonedDateParts(tz, new Date(session.end)).date;
      const group = byWakeDay.get(wakeDay);
      if (group) group.push(session);
      else byWakeDay.set(wakeDay, [session]);
    }
    const wakeDays = [...byWakeDay.keys()]
      .filter((wakeDay) => wakeDay >= since && wakeDay <= until)
      .sort((a, b) => (a < b ? 1 : -1));
    if (wakeDays.length > limit) truncated = true;
    for (const wakeDay of wakeDays.slice(0, limit)) {
      const period = mainSleepPeriod(byWakeDay.get(wakeDay)!);
      if (!period) continue;
      const wake = zonedDateParts(tz, new Date(period.end));
      const bed = zonedDateParts(tz, new Date(period.start));
      const clock = (hhmm: string) =>
        formatClockValue(hhmm, prefs.timeFormat, "", "lower-nospace");
      const source = period.main.source;
      rows.push({
        id: `sleep:${wakeDay}`,
        kind: "sleep",
        profileId,
        tz,
        date: wakeDay,
        // STATED, not "logged": the wake instant is the device's own record of when
        // the night ended, which is exactly what the bare clock grammar is for.
        ...historyClockFields(wake.hhmm || null, "stated", prefs),
        title: "Sleep",
        href: historyHref({ day: wakeDay }),
        // quantity → context → source: the window, the duration it held, the
        // integration that recorded it as the muted tail.
        detail: detailSegment([
          bed.hhmm && wake.hhmm
            ? `${clock(bed.hhmm)} – ${clock(wake.hhmm)}`
            : null,
          formatMinutes(period.durationMin),
          source
            ? (getIntegration(source as IntegrationId)?.name ?? source)
            : null,
        ]),
        media: 0,
        edit: null,
      });
    }
  }

  // ── SYMPTOMS ─────────────────────────────────────────────────────────────
  //
  // ONE ROW PER SYMPTOM-DAY, not one per day. The timeline's symptom entry was a DAY
  // AGGREGATE ("3 symptoms logged") because a feed of cards had no other way to stay
  // readable; the record has one — the rollup below absorbs a bad flu day's ten
  // entries — so the row is the recorded thing itself, correctable in place.
  //
  // `symptom_logs` is `UNIQUE(profile_id, date, symptom)` and carries no clock: it is a
  // DAY row holding that day's worst severity. So the row is date-only and sinks below
  // the day's timed ones, which is the standing rule and not a symptom special case.
  //
  // Ask for one more DAY than the row bound: every day carries at least one row, so
  // reaching that lookahead proves `hasMore` without reading the rest of the window.
  // The day bound itself stays in the shared reader's SQL (#4082).
  if (wants(opts, "symptom")) {
    const days = getSymptomDaysInRange(
      profileId,
      since === ISO_FLOOR ? undefined : since,
      until,
      limit + 1
    );
    // THE PHOTOS FILTER'S FIRST LIVE PREDICATE (#3283/#3958). Every phase-1 composer
    // writes `media: 0`, so the chip could never earn its place; a symptom-day carries
    // its illustrating photos through `symptom_photos.symptom_log_id`, and the range
    // reader hands back the (date, symptom) pairs in ONE statement rather than a
    // per-row probe down the page.
    const photos = new Map<string, number>();
    if (days.length > 0) {
      const oldest = days[days.length - 1].date;
      const newest = days[0].date;
      for (const photo of getSymptomPhotosInRange(profileId, oldest, newest)) {
        const key = `${photo.date}::${photo.symptom}`;
        photos.set(key, (photos.get(key) ?? 0) + 1);
      }
    }
    let emitted = 0;
    outer: for (const day of days) {
      for (const entry of day.symptoms) {
        if (item && item !== entry.symptom) continue;
        if (emitted >= limit) {
          truncated = true;
          break outer;
        }
        emitted += 1;
        rows.push({
          id: `symptom:${day.date}:${entry.symptom}`,
          kind: "symptom",
          profileId,
          tz,
          date: day.date,
          ...historyClockFields(null, "logged", prefs),
          title: symptomLabel(entry.symptom),
          // A symptom has no page of its own, so the title stays plain — the same
          // answer the food groups and the substances give (#4045 §5).
          href: null,
          detail: detailSegment([
            severityLabelFor(entry.symptom, entry.severity),
            entry.note,
          ]),
          media: photos.get(`${day.date}::${entry.symptom}`) ?? 0,
          edit: {
            kind: "symptom",
            symptom: entry.symptom,
            severity: entry.severity,
            note: entry.note,
          },
        });
      }
    }
  }

  // ── STOOL ────────────────────────────────────────────────────────────────
  //
  // ONE ROW PER READING (#4433). A Bristol reading is filed at INSTANT grain because
  // several movements a day is ordinary and each is its own observation — the reason
  // it lives in `metric_samples` rather than in `body_metrics` — so the record lists
  // them individually and the day's rollup absorbs a bad day's six.
  //
  // THE CLOCK IS ALWAYS THE EVENT'S OWN. There is no filing-time fallback to
  // distinguish: a tap states "the moment IS now" and the fold states a minute, so
  // both write the observation's instant into `started_at` and the row renders bare.
  if (wants(opts, "stool")) {
    const readings = getBristolRows(profileId, since, until, limit + 1);
    if (readings.length > limit) truncated = true;
    for (const reading of readings.slice(0, limit)) {
      // A value outside the scale names no type, and the vocabulary is the one guard
      // (`isBristolType`) rather than a range comparison repeated per surface.
      const scale = bristolStoolType(reading.type);
      if (!scale) continue;
      rows.push({
        id: `stool:${reading.id}`,
        kind: "stool",
        profileId,
        tz,
        date: reading.date,
        ...historyClockFields(reading.hhmm, "stated", prefs),
        title: `Type ${scale.type} — ${scale.label}`,
        // Plain, like the food groups and the substances beside it (#4045 §5): the
        // Trends panel is a page-level destination every stool row would share.
        href: null,
        // NO VERDICT (#2785). The scale's own description is context, not a finding —
        // nothing here says a type is good or bad.
        detail: detailSegment([scale.description]),
        media: 0,
        edit: { kind: "stool", rowId: reading.id, type: scale.type },
      });
    }
  }

  // ── CYCLES ───────────────────────────────────────────────────────────────
  //
  // USER-LOGGED LIFECYCLE MARKERS, in the course start/stop shape the medication
  // course events already use: one `cycles` row becomes a "Period started" marker on
  // its start day and, once it is over, a "Period ended" marker on its inclusive last
  // bleeding day. Both markers address the SAME row, so a correction edits the period
  // rather than the marker — which is why the edit payload carries the row and not the
  // marker.
  //
  // RECORDS, NEVER FORECASTS (#3958): `getCycleForecast` is deliberately not read here.
  // A predicted next period is not something that happened.
  if (wants(opts, "cycle")) {
    const periods = listCyclePeriods(profileId);
    const markers: {
      row: (typeof periods)[number];
      date: string;
      end: boolean;
    }[] = [];
    for (const period of periods) {
      markers.push({ row: period, date: period.period_start, end: false });
      if (period.period_end)
        markers.push({ row: period, date: period.period_end, end: true });
    }
    const inWindow = markers
      .filter((marker) => marker.date >= since && marker.date <= until)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (inWindow.length > limit) truncated = true;
    for (const marker of inWindow.slice(0, limit)) {
      const flow =
        marker.row.flow && isFlowLevel(marker.row.flow)
          ? FLOW_LABELS[marker.row.flow]
          : null;
      const cycleDay = cycleDayOnDate(periods, marker.date, todayStr);
      rows.push({
        id: `cycle:${marker.row.id}:${marker.end ? "end" : "start"}`,
        kind: "cycle",
        profileId,
        tz,
        // A cycle marker is a DATE, not an instant — nobody records the minute a
        // period started — so it sinks per the standing rule.
        date: marker.date,
        ...historyClockFields(null, "logged", prefs),
        title: marker.end ? "Period ended" : "Period started",
        href: null,
        detail: detailSegment([
          cycleDay != null ? `Cycle day ${cycleDay}` : null,
          marker.end ? null : flow,
          marker.row.note,
        ]),
        media: 0,
        edit: {
          kind: "cycle",
          cycleId: marker.row.id,
          periodStart: marker.row.period_start,
          periodEnd: marker.row.period_end,
          flow: marker.row.flow,
          note: marker.row.note,
        },
      });
    }
  }

  // ── TRAINING · CLINICAL · LIFE (the re-housed feed) ──────────────────────
  //
  // ONE GATHER, NARROWED IN MEMORY, and the reason is presence rather than laziness:
  // `?kind=` must not be able to change which chips the reader is offered (the phase-1
  // defect — a page filtered to Food reported only Food as present, so every kind→kind
  // move cost two taps). The chips for these families are earned from THIS read, so the
  // read is never narrowed by kind or family and the narrowing happens after.
  //
  // The visibility rules ride along per member: training events are gated on the
  // SUBJECT's own life stage, exactly as the timeline gates them, so `?view=everyone`
  // inherits the gate per row rather than re-deriving it across a widened query.
  const feedKinds = new Set<HistoryKind>();
  {
    let feedEmitted = 0;
    const events = getTimelineEvents(profileId, {
      startDate: since === ISO_FLOOR ? undefined : since,
      endDate: until,
      limit,
      units,
      subjectQualifiedHrefs:
        opts.actingProfileId != null && opts.actingProfileId !== profileId,
      // THE RECORD IS A PROFILE-OWNED DATA SURFACE, so training events are NOT
      // life-stage gated here — `/timeline` said exactly that in its own words
      // ("Training categories and every activity type remain visible at every life
      // stage") and passed no gate at all, which is the default this now takes.
      //
      // Phase 2b gated it on `isTrainingRelevant` and its comment claimed parity
      // with the timeline; the timeline had no such gate, so the claim was wrong and
      // the effect was that a minor's OWN logged sessions vanished from their own
      // record. #3067/#2272 rule the opposite, and e2e/unclassified-activity.spec.ts
      // is that rule's guard — it went on passing only because it was still pointed
      // at `/timeline`. Deleting that route is what surfaced it.
      //
      // The life-stage gates that DO belong are on the training PRODUCT (the dock
      // slot, the nav row, the hub) — what a profile is offered, not what it
      // recorded. A record that hides a person's own data is not a record.
    });
    for (const event of events) {
      const [kind, titleLink] = FEED_RULE[event.category];
      if (kind == null) continue;
      feedKinds.add(kind);
      if (!wants(opts, kind)) continue;
      if (feedEmitted >= limit) {
        truncated = true;
        break;
      }
      feedEmitted += 1;
      // THE INTRADAY AXIS'S EVENT LIST, captured at the emit point (see `dayEvents`
      // on HistoryGather). The `feed:` namespacing is the row's, applied here so the
      // tick and the row it points at agree on one anchor.
      if (opts.day != null)
        dayEvents.push({ ...event, id: `feed:${event.id}` });
      const clockKind = feedClockKind(event.category);
      rows.push({
        // NAMESPACED, because a timeline event id and a Logs row id are two id spaces
        // that both spell `body:12`. The merge's tie-break is a total order on ids, so
        // two rows sharing one id would be a collision rather than a tie.
        id: `feed:${event.id}`,
        kind,
        profileId,
        tz,
        date: event.date,
        ...historyClockFields(event.sortTime ?? null, clockKind, prefs),
        title: event.title,
        // A title links only when the event names its own surface (or its own History
        // view), never when the old feed offered a bare hub as nearby navigation.
        href: titleLink === "event" ? (event.href ?? null) : null,
        // quantity → context, through the ONE separator. The feed's own composers built
        // `subtitle` and `detail` as separate strings for a two-line card; on a one-line
        // row they are one segment, joined by the grammar rather than by each composer.
        detail: detailSegment([event.subtitle, event.detail]),
        // Carried from the gather that read the event (#3285 item 3): a training
        // session's and an event's photo counts are the feed's first live media
        // predicate, exactly as symptom_photos is the Logs half's.
        media: event.media ?? 0,
        // › AND NEVER ⋯: a lab, a visit, an imported activity, a protocol change are
        // corrected on the surface that owns them. #3958 rules the affordance exclusive
        // and provenance decides which — this is the › half.
        edit: null,
        // THE DISCLOSURE'S CONTENT, carried across unchanged (#662/#2920, phase 2d).
        // These are the three fields the feed's gathers compute and `/timeline`'s card
        // was the only thing that ever rendered; the record's row is one line, so they
        // ride to its disclosure panel instead. Spread conditionally so a row without
        // them carries no keys at all — `mergeMemberTimelines` compares rows and an
        // explicit `undefined` is not the same absence.
        ...(event.detailItems && event.detailItems.length > 0
          ? { detailItems: event.detailItems }
          : {}),
        ...(event.linkedRefs && event.linkedRefs.length > 0
          ? {
              linkedRefs: event.linkedRefs,
              linkedScope: event.linkedRefsScope,
            }
          : {}),
        // THE ROW'S OWN GLYPH, carried across on the same terms (#4079). Only the
        // activity composer sets these, and a row without `iconType` keeps the closed
        // kind registry's glyph — so this widens nothing for the kinds that never
        // asked.
        ...(event.iconType
          ? {
              iconType: event.iconType,
              ...(event.iconTitle ? { iconTitle: event.iconTitle } : {}),
              ...(event.iconSportNames && event.iconSportNames.length > 0
                ? { iconSportNames: event.iconSportNames }
                : {}),
            }
          : {}),
      });
    }
  }

  // THE RECORD ENDS AT NOW, applied to the gathered set rather than to each reader's
  // SQL: one rule, one place, and a kind that grows a future-dated row later inherits
  // it without a second clause.
  const dated = rows.filter((row) => row.date <= todayStr);

  // A FILTER NOTHING CAN SATISFY DEGRADES, like every other unsatisfiable one on this
  // page (owner ruling 2026-08-29). When this shipped no kind carried row media at
  // all — every composer wrote `media: 0` — so a hand-typed `?media=1` rendered
  // "Nothing recorded here yet." over a full record, which is a page ASSERTING
  // emptiness rather than degrading to what it can show. Symptom days carry it now,
  // and training sessions and events do too (#3285 item 3).
  //
  // ASKED OF THE ROWS, NOT OF THE PHASE. The moment a kind starts carrying media the
  // filter starts working, with no edit here and nothing to remember to undo; and a
  // profile that simply has no photos still gets the filter applied honestly, because
  // the question is whether ANY row this gather produced carries any.
  const mediaApplied =
    opts.media === true && dated.some((row) => row.media > 0);
  const bounded = mediaApplied ? dated.filter((row) => row.media > 0) : dated;

  return {
    rows: bounded,
    hasMore: truncated,
    // THE LOGS KINDS ARE PROBED and the feed kinds are earned from the read above:
    // both answers are independent of `?kind`/`?family`, which is the property that
    // matters. The feed half is "present in the bounded read" rather than "present
    // ever" — the per-table caps inside the feed gather mean a category with any row in
    // the window produces one — and the record's window is the reader's own.
    presentKinds: [
      ...historyPresentKinds(profileId),
      ...HISTORY_KINDS.filter((kind) => feedKinds.has(kind)),
    ],
    mediaApplied,
    today: todayStr,
    dayEvents,
  };
}

/**
 * One member's gather in the shape `mergeMemberTimelines` merges — the SAME merge the
 * timeline's multi-view uses (#1329), so day bucketing, the divergent-day marks and
 * the within-day order are inherited rather than answered a second time.
 *
 * The member's `today` is the member's OWN (the per-profile-context trap #1096): a
 * relative-day label computed in the acting profile's clock is the defect that merge
 * exists to prevent.
 */
export function historyMemberFeed(
  profileId: number,
  opts: HistoryGatherOptions
): MemberTimeline<HistoryRow> & { gather: HistoryGather } {
  const gather = gatherHistoryLog(profileId, opts);
  return {
    profileId,
    today: gather.today,
    events: gather.rows,
    gather,
  };
}
