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
import { bestKnownInstant } from "./row-instants";
import { getIntakeDoseLedgerPage } from "./queries";
import { getFoodLedgerPage } from "./queries/nutrition";
import { getPracticeLedgerPage } from "./queries/wellness";
import { getAllSubstanceDailyTotals } from "./queries/substance";
import { getBodyMetricsOnDate, getBodyMetricsPage } from "./queries/metrics";
import { bodyMetricMeasures } from "./body-metric-measures";
import { foodGroupBySlug } from "./food-groups";
import { foodEventWindow } from "./food-slot-count";
import { profileFoodSlotBoundaries } from "./profile-food-slot";
import { normalizePracticeName } from "./practice";
import { formatMinutes } from "./duration";
import { ALCOHOL_FOOD_GROUP, substanceDef } from "./substance-use";
import { intakeHref, medicationHref, metricDetailHref } from "./hrefs";
import {
  detailSegment,
  historyClock,
  type HistoryLogKind,
  type HistoryRow,
} from "./history-format";
import type { MemberTimeline } from "./timeline-multi";

// A window with no lower bound. The record outlives retirement — a dose taken years
// ago still happened — so the floor is a floor, not a default range.
const ISO_FLOOR = "0001-01-01";

export interface HistoryGatherOptions {
  /** The login whose display preferences format every clock on the page. */
  loginId: number;
  /** Narrow to one kind. Undefined = every Logs kind. */
  kind?: HistoryLogKind;
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
}

export interface HistoryGather {
  rows: HistoryRow[];
  /** Whether the bound cut anything off — the load-more control's whole predicate. */
  hasMore: boolean;
  /** The kinds this profile has ANY row for: what earns a filter chip (#3958). */
  presentKinds: HistoryLogKind[];
  /** The subject's own today, in the subject's own timezone. */
  today: string;
}

function wants(opts: HistoryGatherOptions, kind: HistoryLogKind): boolean {
  return opts.kind == null || opts.kind === kind;
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
export function historyPresentKinds(profileId: number): HistoryLogKind[] {
  // ONE LITERAL STATEMENT PER KIND, and the repetition is the point — the scoping
  // scanner verifies `profile_id` in the literal SQL text of every prepared statement
  // over an owned table, and a helper taking the SQL as a parameter is one it cannot
  // read. `bodyMetricSelect` in lib/metric-readings.ts makes the same trade in the
  // same layer, for the same reason: a scannable statement beats a clever one where
  // the question is whose rows you see.
  const out: HistoryLogKind[] = [];
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
  if (
    !isMinor(getProfileAge(profileId)) &&
    getAllSubstanceDailyTotals(profileId).length > 0
  ) {
    out.push("substance");
  }
  const body = db
    .prepare("SELECT 1 FROM body_metrics WHERE profile_id = ? LIMIT 1")
    .get(profileId);
  if (body != null) out.push("body");
  return out;
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
  const rows: HistoryRow[] = [];
  let truncated = false;

  // ── DOSES ────────────────────────────────────────────────────────────────
  // The cross-item dose ledger's own reader (#2445), asked for one page the size of
  // the page's bound. `class` is the pre-filter the two deleted routes encoded as two
  // paths; here it is a param on one page, exactly as `?kind=dose&class=medication`.
  if (wants(opts, "dose")) {
    const itemId = Number(opts.item);
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
      rows.push({
        id: `dose:${row.id}`,
        kind: "dose",
        profileId,
        date: row.date,
        sortTime: hhmm,
        clock: historyClock(
          hhmm,
          when.known && when.semantic === "event" ? "stated" : "logged",
          prefs
        ),
        clockKind:
          when.known && when.semantic === "event" ? "stated" : "logged",
        title: row.item_name,
        href:
          row.item_kind === "medication"
            ? medicationHref(row.item_id)
            : intakeHref("supplement"),
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
  //      one thing.
  //   3. The substance row describes the act in the person's own terms ("1 standard
  //      drink") rather than as a serving of a food group.
  //
  // THE DRINK DOES NOT DISAPPEAR, and that was checked rather than reasoned: the
  // food door writes the `food_daily_totals` counter as well as the event
  // (lib/food-log-write.ts keeps them as one fact in two shapes), and
  // `getAllSubstanceDailyTotals` reads that counter — so a serving logged through
  // Nutrition still reaches the record, once, as a substance. Food TOTALS are
  // untouched: this is the record's row set, not the nutrition arithmetic.
  if (wants(opts, "food")) {
    const boundaries = profileFoodSlotBoundaries(profileId);
    const ledger = getFoodLedgerPage(
      profileId,
      since,
      {
        untilDate: until,
        groupKey: opts.item,
        excludeSubstanceGroups: true,
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
        date: row.date,
        sortTime: hhmm,
        clock: historyClock(hhmm, stated ? "stated" : "logged", prefs),
        clockKind: stated ? "stated" : "logged",
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
            boundaries,
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
            boundaries,
            row.meal_slot,
            row.occurred_at
          ),
          clock: hhmm,
          clockKind: stated ? "stated" : "logged",
        },
      });
    }
  }

  // ── PRACTICES ────────────────────────────────────────────────────────────
  if (wants(opts, "practice")) {
    const ledger = getPracticeLedgerPage(
      profileId,
      since,
      { untilDate: until, practice: opts.item },
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
        date: row.date,
        sortTime: hhmm,
        clock: historyClock(hhmm, stated ? "stated" : "logged", prefs),
        clockKind: stated ? "stated" : "logged",
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
          // carries what it must post back unchanged — and `time` is the STORED
          // column, not the resolved instant above it. `hhmm` may be the record
          // chain's minute; this never is.
          statedTime: row.time,
          durationMin: row.duration_min,
          notes: row.notes,
        },
      });
    }
  }

  // ── SUBSTANCES ───────────────────────────────────────────────────────────
  // LIFE-STAGE GATED, exactly as the surface that owns them is (#1174/#1279): the
  // substance record is adult-only content, and a page that merged it in for a known
  // minor would be widening exposure past what that profile's own pages show. Asked of
  // the SUBJECT's age, so `?view=everyone` inherits the gate per member.
  if (wants(opts, "substance") && !isMinor(getProfileAge(profileId))) {
    const totals = getAllSubstanceDailyTotals(profileId).filter(
      (row) =>
        row.date <= until &&
        row.date >= since &&
        (!opts.item || opts.item === row.substance)
    );
    if (totals.length > limit) truncated = true;
    for (const row of totals.slice(0, limit)) {
      const def = substanceDef(row.substance);
      rows.push({
        id: `substance:${row.substance}:${row.id}`,
        kind: "substance",
        profileId,
        date: row.date,
        // A DAY TOTAL HAS NO INSTANT and the schema says so — `substance_daily_totals`
        // records when a use was LOGGED and nothing about when it happened. So the row
        // is date-only and sinks below the day's timed rows, which is the standing rule
        // rather than a substance special case.
        sortTime: null,
        clock: null,
        clockKind: "logged",
        title: def.label,
        href: "/records/specialty/substance-use",
        detail: detailSegment([
          `${row.amount} ${row.amount === 1 ? def.countSingular : def.countPlural}`,
          row.notes,
        ]),
        media: 0,
        edit: {
          kind: "substance",
          rowId: row.id,
          substance: row.substance,
          amount: row.amount,
          notes: row.notes,
        },
      });
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
    const bodyRows = opts.day
      ? getBodyMetricsOnDate(profileId, opts.day)
      : getBodyMetricsPage(profileId, 1, limit + 1).rows;
    // THE BOUND COUNTS RENDERED ROWS, NOT STORED ONES. A `body_metrics` row fans out
    // to up to three measures, so bounding the READ alone let `limit` render three
    // times what every other kind renders — and "Load more" then had to reveal rows
    // the bound had never actually withheld. The read stays bounded (it is what keeps
    // the query small); this is the second half, counted where the rows are made.
    let bodyEmitted = 0;
    for (const row of bodyRows) {
      if (bodyEmitted >= limit) {
        truncated = true;
        break;
      }
      const when = bestKnownInstant("body_metrics", { ...row });
      const hhmm = when.known ? localClock(tz, when.at) : null;
      for (const measure of bodyMetricMeasures(row, units.weightUnit)) {
        if (opts.item && opts.item !== measure.slug) continue;
        if (bodyEmitted >= limit) {
          truncated = true;
          break;
        }
        bodyEmitted += 1;
        rows.push({
          id: `body:${measure.column}:${row.id}`,
          kind: "body",
          profileId,
          date: row.date,
          sortTime: hhmm,
          // `body_metrics` has no record stamp at all, so an unstated reading is
          // genuinely date-only rather than falling back to a filing time.
          clock: historyClock(hhmm, "stated", prefs),
          clockKind: "stated",
          title: measure.label,
          href: metricDetailHref(measure.slug),
          // The SAME number the editor opens on, formatted once — the detail and the
          // edit field cannot disagree because there is only one value between them.
          detail: detailSegment([
            `${measure.value}${measure.unit}`,
            row.source,
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

  // THE RECORD ENDS AT NOW, applied to the gathered set rather than to each reader's
  // SQL: one rule, one place, and a kind that grows a future-dated row later inherits
  // it without a second clause.
  const bounded = rows.filter(
    (row) => row.date <= todayStr && (!opts.media || row.media > 0)
  );

  return {
    rows: bounded,
    hasMore: truncated,
    presentKinds: historyPresentKinds(profileId),
    today: todayStr,
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
