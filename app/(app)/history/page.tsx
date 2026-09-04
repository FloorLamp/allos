import { Fragment } from "react";
import { measurementsQuickEntry } from "@/lib/quick-entry-measurements";
import Link from "next/link";
import PageContainer from "@/components/PageContainer";
import DestinationLink from "@/components/DestinationLink";
import { PageHeader, EmptyState } from "@/components/ui";
import Chip from "@/components/Chip";
import FilterPills from "@/components/FilterPills";
import JumpRailScrubber, {
  type ScrubberStop,
} from "@/components/JumpRailScrubber";
import EventCalendar from "@/components/EventCalendar";
import type { DoseLedgerItem } from "@/components/intake/dose-ledger-entry";
import HistoryRows from "./HistoryRows";
import HistoryAddDoor, { HistoryUsualOffers } from "./HistoryAddDoor";
import HistoryFoldCard from "./HistoryFoldCard";
import { requireScope } from "@/lib/scope";
import { today } from "@/lib/db";
import {
  getDisplayFormatPrefs,
  getHomeLocation,
  getProfileAge,
  getTimezone,
} from "@/lib/settings";
import {
  getCustomSymptomNames,
  getDaylightOutdoorMinutesByDay,
  getIntakeDoses,
  getIntakeItems,
  getMoodOnDate,
  getSymptomLogOrder,
  isAnxietyScaleRelevant,
} from "@/lib/queries";
import { getTrackedPractices } from "@/lib/queries/wellness";
import { getTimelineDates } from "@/lib/timeline";
import { usualRoutineDayOffers } from "@/lib/queries/usual-routine";
import { profileFoodSlotBoundaries } from "@/lib/profile-food-slot";
import { getProfileSubstanceKeys } from "@/lib/queries/substance";
import { substanceDef } from "@/lib/substance-use";
import { isOnDemand } from "@/lib/intake-schedule";
import {
  formatClockMinutes,
  formatLongDate,
  formatMonthDay,
  formatRelativeTime,
} from "@/lib/format-date";
import { shiftDateStr, zonedDateParts } from "@/lib/date";
import TimelineDayNav from "@/components/TimelineDayNav";
import IntradayPanel from "@/components/IntradayPanel";
import { IntradayInteractionProvider } from "@/components/IntradayInteraction";
import HistoryAddRow from "./HistoryAddRow";
import { parseIntradayWindow } from "@/lib/intraday-window";
import { getIntradayDay } from "@/lib/queries/intraday";
import { solarDay } from "@/lib/sun";
import {
  getLastNightSummary,
  getSleepWaitingState,
  typicalBedTime,
  typicalWakeTime,
} from "@/lib/queries/sleep";
import { sleepWaitingDetail } from "@/lib/sleep-waiting";
import { getUvDoseForDays } from "@/lib/queries/weather";
import { evaluateSeries, notableStatesSummary } from "@/lib/weather-situations";
import {
  WEATHER_SERIES_LOOKBACK_DAYS,
  getWeatherDaysForProfile,
} from "@/lib/queries/weather-situations";
import { listCyclePeriods } from "@/lib/cycle-store";
import { cyclePhaseOnDate, periodOnDate } from "@/lib/cycle";
import { PICKER_SYMPTOMS, symptomLabel } from "@/lib/symptoms";
import {
  historyHref,
  type HistoryHrefParams,
  type AppRoute,
} from "@/lib/hrefs";
import { historyMemberFeed } from "@/lib/history";
import {
  HISTORY_DEFAULT_SHOW,
  HISTORY_FAMILIES,
  HISTORY_FAMILY_KINDS,
  HISTORY_FAMILY_LABELS,
  HISTORY_KIND_LABELS,
  HISTORY_KINDS,
  HISTORY_MAX_SHOW,
  HISTORY_SHOW_STEP,
  clampHistoryDay,
  historyAddKinds,
  historyKindFamily,
  layoutHistoryDay,
  parseHistoryExpand,
  parseHistoryShow,
  resolveHistoryDoseClass,
  resolveHistoryFamily,
  resolveHistoryKind,
  type HistoryFamily,
  type HistoryKind,
  type HistoryRow,
} from "@/lib/history-format";
import { TIMELINE_EMPTY_ACTIONS } from "@/lib/timeline-format";
import { closeAbandonedPracticeSessions } from "@/lib/practice-log";
import { isTrainingRelevant } from "@/lib/life-stage";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import {
  parseTimelineOpen,
  renderedTimelineDays,
  toggledTimelineOpen,
  windowTimelineDays,
} from "@/lib/timeline-window";
import {
  SCRUBBER_GUTTER_CLASS,
  showTimelineScrubber,
  timelineScrubberTicks,
} from "@/lib/timeline-scrubber";

export const dynamic = "force-dynamic";

// `/history` — THE APP'S RECORD (issue #3958, phase 1).
//
// Every discrete thing a profile logged, day-grouped, newest first, correctable in
// place. It replaced the four standalone ledger routes — two dose doors, one for food
// and one for practices — which were four copies of one page differing only in which
// table they read, and which each answered "when" and "how much" in their own words.
// There are no redirects: those routes are gone and every door that pointed at one now
// points here, because a shim is a compatibility layer standing where a fixed call site
// should be. Their paths are deliberately not spelled anywhere in the tree, so
// `git grep` answering nothing IS the acceptance criterion.
//
// WHAT THIS FILE OWNS. The URL → read → render seam, and nothing about a domain: the
// row grammar is lib/history-format.ts's, the composers are lib/history.ts's, the
// folds and the rail are #2657's (inherited verbatim from /timeline, which phase 2
// retired), and every write is the domain's own Server Action reached through
// HistoryRows.
//
// THE CHROME BUDGET IS AN ACCEPTANCE CRITERION: ≤ ~140px above the first record at
// 390px. What buys that is stated so an addition has to name what it displaces — no
// h1/subtitle below `sm` (#1616/#1661: the nav already names the page), ONE filter row,
// NO range chrome at all (the record is navigated, not windowed), and day headers that
// stick rather than repeating a date on every row.
//
// A BAD DEEP LINK DEGRADES TO THE PAGE. Every parser here answers "or All": an unknown
// kind, a retired family, a future day. A record surface that 404s on a hand-edited
// URL is a record you cannot get back to.
//
// ── THE #2657 SCROLL RESTORER IS GONE, NOT MISSING ──────────────────────────
//
// Written down because the next reader will find `scroll={false}` on every chip and
// fold card and wonder where the restore half went. `TimelineScrollRestorer` recorded
// the day sitting under the filter controls on a chip tap and scrolled it back
// afterwards. That was right for `/timeline`, whose filter row and date-range control
// re-queried the whole feed; it was never mounted here, because #4062 re-nested the
// folds so an open month's days render UNDER their own card and `scroll={false}`
// alone leaves the reader looking at the card they tapped — mounting the restorer
// would have scrolled them AWAY from it, undoing that fix.
//
// With `/timeline` deleted it had no consumer left, so it retired with the route
// exactly as the note that stood here said it would. The chip case is the one that
// would still have benefited, and separating it would mean a per-link flag on the
// shared control — a second shape of one component selected by a prop. Raised rather
// than built.

// The fold card itself is `./HistoryFoldCard.tsx` (#4365) — a CLIENT component,
// because its navigation now wraps a browser View Transition and a hook cannot
// cross the server/client boundary this async page renders across. Its own header
// carries the "why here, why nested" notes that used to live on this inline
// function.

// The first value of a repeatable query param. A private copy, matching the ones in
// `app/(app)/trends/page.tsx:46` and `components/DataExport.tsx:7` rather than inventing
// a fourth spelling — converging the three is #4553's, not this lane's.
function firstQueryParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HistoryPage(props: {
  searchParams: Promise<{
    family?: string | string[];
    kind?: string | string[];
    class?: string | string[];
    item?: string | string[];
    media?: string | string[];
    day?: string | string[];
    view?: string | string[];
    open?: string | string[];
    expand?: string | string[];
    show?: string | string[];
    /** A window selected on the day chart (#4950) — see lib/intraday-window.ts. */
    from?: string | string[];
    to?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const todayStr = today(actingProfileId);
  closeAbandonedPracticeSessions(actingProfileId);
  const prefs = getDisplayFormatPrefs(loginId);

  // A kind IMPLIES its family, so `?family=` only matters when no kind is named. Phase
  // 1 ships the Logs family alone: a `?family=clinical` link written against phase 2
  // resolves, finds nothing of that family here, and falls back to All rather than
  // 404ing.
  const kind = resolveHistoryKind(searchParams.kind);
  const family = resolveHistoryFamily(searchParams.family);
  const doseClass = resolveHistoryDoseClass(searchParams.class);
  const rawItem = Array.isArray(searchParams.item)
    ? searchParams.item[0]
    : searchParams.item;
  const media =
    (Array.isArray(searchParams.media)
      ? searchParams.media[0]
      : searchParams.media) === "1";
  const day = clampHistoryDay(searchParams.day, todayStr);
  // THE WINDOW THE CHART STATED (#4950), and only ON a day. The chart that writes it is
  // the day view's, so a `?from=` arriving on the feed names a window over nothing —
  // dropped here rather than carried to a door that could not use it anyway.
  const chartWindow = day
    ? parseIntradayWindow(
        firstQueryParam(searchParams.from),
        firstQueryParam(searchParams.to)
      )
    : null;
  const show = parseHistoryShow(searchParams.show);
  const openFolds = parseTimelineOpen(searchParams.open);
  // THE ROLLUP LINES THE READER HAS OPENED (#3958 phase 2). A second param beside
  // `?open=` because they are different questions with different key vocabularies —
  // `parseTimelineOpen` validates a year, a month or the ahead key, and a rollup key is
  // a (day, member) pair. Same toggle helper, so the URL stays sorted and stable.
  const expanded = parseHistoryExpand(searchParams.expand);

  // THE HOUSEHOLD VIEW IS A DEEP-LINKED MODE, NOT A SWITCHER (#1463): the sidebar is
  // the one profile switcher on every page, so this costs the chrome budget nothing.
  // It composes the SAME per-profile gather once per member — which is what makes
  // every visibility rule (age gates, substance exclusions) inherited per row rather
  // than re-derived across a widened query.
  const everyone =
    (Array.isArray(searchParams.view)
      ? searchParams.view[0]
      : searchParams.view) === "everyone" && viewIds.length > 1;
  const memberIds = everyone ? viewIds : [actingProfileId];

  const feeds = memberIds.map((id) =>
    historyMemberFeed(id, {
      loginId,
      kind,
      family,
      doseClass,
      item: rawItem,
      media,
      day,
      limit: show,
      actingProfileId,
    })
  );
  const presentKinds = HISTORY_KINDS.filter((candidate) =>
    feeds.some((feed) => feed.gather.presentKinds.includes(candidate))
  );
  // A FAMILY CHIP IS EARNED BY ITS KINDS, so an empty family never advertises itself —
  // the substance quiet-access posture applied uniformly, as #3958 asks. Derived from
  // the same presence answer the refinement row uses, so the two rows cannot disagree.
  const presentFamilies = HISTORY_FAMILIES.filter((candidate) =>
    HISTORY_FAMILY_KINDS[candidate].some((k) => presentKinds.includes(k))
  );
  // WHICH FAMILY THE PAGE IS IN. A kind implies its family, so a refinement row is
  // showing whenever either is set — and never in All, which is the issue's own rule.
  const activeFamily: HistoryFamily | null = kind
    ? historyKindFamily(kind)
    : (family ?? null);
  // WHETHER THE PHOTOS FILTER IS ON, as the gather answers it rather than as the URL
  // asks: `?media=1` degrades when no row can satisfy it, so the chip must not paint
  // itself pressed over a page that is showing everything.
  const mediaApplied = feeds.some((feed) => feed.gather.mediaApplied);
  const hasMedia = feeds.some((feed) =>
    feed.gather.rows.some((row) => row.media > 0)
  );

  // ONE grouping engine for one member and for five (#1329/#221). The within-day
  // order is its comparator's: instant descending, date-only rows sinking below timed
  // ones, and a same-instant tie-break on id — which is what makes the order
  // byte-stable when one usual-routine tap writes six rows in the same minute.
  const allDays = mergeMemberTimelines(feeds);
  const days = allDays.slice(0, undefined);

  // WINDOWING (#2657), except on the day view: a day IS the window, and folding it
  // would fold the surface's whole content away. There is no `ahead` fold to draw —
  // the gather already ends the record at now.
  const windowed = day ? null : windowTimelineDays(days, todayStr, openFolds);
  const renderedDays = windowed ? renderedTimelineDays(windowed) : days;

  // SWITCHING KIND DROPS WHAT BELONGED TO THE OLD ONE — the deleted ledger's rule
  // ("an item belongs to one kind, so carrying it across would leave a filter naming
  // nothing"), applied to both kind-scoped params. `class` is the DOSE two-door
  // pre-filter and means nothing on any other kind, so a chip that leaves doses must
  // not carry it: a row of chips whose "All" still says `class=medication` is a
  // control that does not do what it is called.
  // Split from the speller (#4950) so a client surface can take the PARAMS these rules
  // produce and add to them, rather than re-deriving the rules or editing a finished
  // URL. `historyHref` stays the one place a history URL is spelled.
  const chipHrefParams = (next: {
    kind?: HistoryKind;
    family?: HistoryFamily;
    media?: boolean;
  }): HistoryHrefParams => {
    const nextKind = "kind" in next ? next.kind : kind;
    // A FAMILY CHIP DROPS THE KIND INSIDE IT. Moving to Clinical while `?kind=dose` was
    // set would produce a URL that contradicts itself (a kind implies its family), and
    // `historyHref` resolves that by dropping the family — so the Clinical chip would
    // have navigated back to Doses.
    const nextFamily =
      "family" in next ? next.family : "kind" in next ? undefined : family;
    return {
      family: nextKind ? undefined : nextFamily,
      kind: nextKind,
      class: nextKind === "dose" ? doseClass : undefined,
      item: "kind" in next || "family" in next ? undefined : rawItem,
      media: next.media ?? mediaApplied,
      day,
      everyone,
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    };
  };

  const chipHref = (next: {
    kind?: HistoryKind;
    family?: HistoryFamily;
    media?: boolean;
  }): AppRoute => historyHref(chipHrefParams(next));

  // THE DAY NAV'S TWO DESTINATIONS. Same day, one step either way, and every other
  // filter the reader has set rides across — walking days inside `?kind=dose` stays
  // inside it. The fold and rollup open-sets are deliberately DROPPED: they are the
  // scrolling feed's state and a day view has no folds to open.
  const dayNavHref = (target: string): AppRoute =>
    historyHref({
      family: kind ? undefined : family,
      kind,
      class: doseClass,
      item: rawItem,
      media: mediaApplied,
      day: target,
      everyone,
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });

  // THE ROLLUP LINE'S OWN LINK — the same toggle helper the folds use, so the `?expand`
  // set is sorted and the href for a given open set is byte-identical across renders.
  const expandHref = (key: string): AppRoute =>
    historyHref({
      family: kind ? undefined : family,
      kind,
      class: doseClass,
      item: rawItem,
      media: mediaApplied,
      day,
      everyone,
      open: [...openFolds].sort(),
      expand: toggledTimelineOpen(expanded, key),
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });

  const foldHref = (
    key: string,
    fold?: { open: boolean; descendants: readonly string[] },
    anchor?: string
  ): AppRoute => {
    const base = historyHref({
      family: kind ? undefined : family,
      kind,
      class: doseClass,
      item: rawItem,
      media: mediaApplied,
      day,
      everyone,
      open: toggledTimelineOpen(openFolds, key, fold),
      expand: [...expanded].sort(),
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });
    return anchor ? (`${base}#${anchor}` as AppRoute) : base;
  };

  // THE JUMP RAIL (#2657 item 4) — stops derived from what THIS render put in the
  // document, so a month sealed inside a collapsed year never gets a tick the scroll
  // cannot keep. It owns a lane: `SCRUBBER_GUTTER_CLASS` is the rail's intrusion into
  // the content column, applied to every surface underneath it, so the strip never
  // overlays a row's action column.
  const ticks = windowed ? timelineScrubberTicks(windowed) : [];
  const stops: ScrubberStop[] = showTimelineScrubber(ticks)
    ? ticks.map((tick) => ({
        ...tick,
        href: tick.openKey
          ? foldHref(tick.openKey, undefined, tick.anchorId)
          : null,
      }))
    : [];
  // SPENDING THE RAIL'S LANE, AND AT WHAT DEPTH (#4045 §2, owner ruling 2026-08-29).
  //
  // THE LANE DOES NOT EXIST ON A WIDE VIEWPORT, which is #3958's own spec — "on wide
  // viewports it sits in the margin beside the card; on narrow desktops the page
  // reserves a right gutter". The strip is fixed to the VIEWPORT's right edge, and from
  // `xl` the margin between the reading column and that edge is already wider than the
  // strip, so nothing is reserved and every card runs the full width of the feed.
  //
  // BELOW `xl` THE CARVE-OUT IS SPENT AT ONE DEPTH FOR EVERY CARD — the day SECTION and
  // the fold SECTION, siblings inside `#history-feed`. The shipped page spent it at TWO
  // depths (the fold's outer section, the day's inner row wrapper) at every width, so
  // the day band's border ran 28px past every fold card's.
  //
  // BELOW `sm` IS THE ONE EXCEPTION and it is #3920's shape, not a drift: the band goes
  // full-bleed there, so a gutter on its section would stop the fill reaching the edge
  // and strand a strip of page beside it. The ROW content spends the lane instead, and
  // the band has no side border at that width for anything to align with.
  //
  // The responsive halves are spelled as literals rather than composed from
  // `SCRUBBER_GUTTER_CLASS`, because Tailwind scans source text for whole class names
  // and an interpolated `sm:${TOKEN}` generates no CSS at all. What holds them to the
  // token is not a second literal but the geometry guard in e2e/history.spec.ts, which
  // measures the two card edges at two widths and reads no class string.
  const railGutter = stops.length > 0 ? `${SCRUBBER_GUTTER_CLASS} xl:pr-0` : "";
  const dayGutter = stops.length > 0 ? "sm:pr-7 xl:pr-0" : "";
  const rowGutter = stops.length > 0 ? `${SCRUBBER_GUTTER_CLASS} sm:pr-0` : "";

  // The dose form's vocabulary, read once for the whole page: which items exist (an
  // item retired since the dose was taken still took it, so history keeps listing it)
  // and which of them still have a live dose to log against.
  const allItems = getIntakeItems(actingProfileId);
  const dosesByItem = new Map<
    number,
    { id: number; amount: string | null; time_of_day: string | null }[]
  >();
  for (const dose of getIntakeDoses(actingProfileId)) {
    const list = dosesByItem.get(dose.item_id) ?? [];
    list.push({
      id: dose.id,
      amount: dose.amount,
      time_of_day: dose.time_of_day,
    });
    dosesByItem.set(dose.item_id, list);
  }
  const doseItems: DoseLedgerItem[] = allItems.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    product: item.product,
    asNeeded: isOnDemand(item),
    doses: dosesByItem.get(item.id) ?? [],
  }));
  const loggable = doseItems.filter((item) => item.doses.length > 0);
  const canWrite = scope.access.get(actingProfileId) === "write";
  // WHICH PROFILES IN VIEW THIS LOGIN MAY WRITE (#4009 item 1 / #2106). Resolved once
  // from the scope's already-computed access map — no second `accessForProfile` pass —
  // and handed to the rows as a SET, because in `?view=everyone` the answer differs per
  // member: a caregiver can hold write on one and read-only on another. This decides
  // whether the ⋯ is DRAWN. It is not the gate: the gate is `gateItemProfile` inside
  // each correction action, which re-checks at apply time, so a forged submit naming a
  // profile this login cannot write is refused whatever this list said.
  const writableProfileIds = memberIds.filter(
    (id) => scope.access.get(id) === "write"
  );
  // AND EACH MEMBER'S OWN TODAY (#4009 item 1). A correction's date field may reach
  // that member's current day and no further — which is not the caregiver's, for a
  // member in a zone ahead of theirs. The server already bounds on the gated profile;
  // this is the client half saying the same thing.
  const maxDates = Object.fromEntries(memberIds.map((id) => [id, today(id)]));
  // THE OTHER FOUR DOORS' VOCABULARY, read once and only for the kind that is showing
  // one. Each list is a shared reader the kind's own surface already uses — no fifth
  // derivation of "what can this profile log".
  // WHICH KINDS THE ADD DOOR CAN BE (#3958: "Log kinds only"). Clinical, training and
  // life records are created on their domain surfaces, and sleep arrives from an
  // integration and is corrected at its source.
  const addKind =
    kind === "food" ||
    kind === "dose" ||
    kind === "practice" ||
    kind === "mood" ||
    kind === "substance" ||
    kind === "body" ||
    kind === "symptom" ||
    kind === "stool"
      ? kind
      : null;
  const defaultTime = zonedDateParts(
    getTimezone(actingProfileId),
    new Date()
  ).hhmm;
  const addVocabulary =
    canWrite && addKind
      ? {
          practices:
            addKind === "practice"
              ? getTrackedPractices(actingProfileId).map((p) => p.name)
              : [],
          substances:
            addKind === "substance"
              ? getProfileSubstanceKeys(actingProfileId).map((key) => ({
                  key,
                  label: substanceDef(key).label,
                }))
              : [],
          // THE SAME VOCABULARY THE BAR OFFERS, in the same ranked order (#857): this
          // profile's history first, then the curated catalog, then its own customs.
          // Free text still logs — `logSymptomCore` is the one place a custom key is
          // minted, so the door never has to guess one.
          symptoms:
            addKind === "symptom"
              ? [
                  ...new Set([
                    ...getSymptomLogOrder(actingProfileId),
                    ...PICKER_SYMPTOMS.map((entry) => entry.slug),
                    ...getCustomSymptomNames(actingProfileId),
                  ]),
                ].map((key) => ({ key, label: symptomLabel(key) }))
              : [],
          // ONLY ITEMS WITH A LIVE DOSE, which is the dose door's own presence rule
          // (`hasAddDoor` below reads the same list): an item whose schedule is
          // entirely retired keeps its history and takes no new rows.
          doseItems: addKind === "dose" ? loggable : [],
          doseDefaultTime: defaultTime,
          // WHAT THE BODY DOMAIN'S ONE FORM NEEDS ON THE DAY BEING READ (#4424
          // ruling 2) — the same reader the quick-log sheet's measurements overlay
          // uses, asked for this day instead of today, so the door and the sheet
          // cannot disagree about which fields a body sitting has.
          measurements: measurementsQuickEntry(
            loginId,
            actingProfileId,
            day ?? todayStr
          ),
          moodDay: {
            date: day ?? todayStr,
            label: formatMonthDay(day ?? todayStr, prefs, {
              today: todayStr,
            }),
            mood: getMoodOnDate(actingProfileId, day ?? todayStr),
          },
          moodShowCalm: isAnxietyScaleRelevant(actingProfileId),
          // The acting profile's meal-bucket boundaries, so the food form's Meal
          // follows a stated hour here exactly as it does in the nutrition bar.
          foodSlotBoundaries: profileFoodSlotBoundaries(actingProfileId),
        }
      : null;
  // WHETHER THIS KIND HAS A DOOR AT ALL — the dose door's own presence rule, which the
  // other kinds inherit: a picker with nothing in it is worse than no control. A kind
  // that cannot offer one falls back to the kind chooser rather than to an empty row,
  // which is what the dose branch already did.
  const hasAddDoor = addVocabulary
    ? addKind === "dose"
      ? addVocabulary.doseItems.length > 0
      : addKind === "practice"
        ? addVocabulary.practices.length > 0
        : addKind === "substance"
          ? addVocabulary.substances.length > 0
          : addKind === "symptom"
            ? addVocabulary.symptoms.length > 0
            : true
    : false;
  // THE DAY'S STANDING COMPOSED OFFERS (#4118), read for the day being looked at rather
  // than for a kind (#4310 ruling): the usual is an offer over foods and stacks, never a
  // food, so it leads the add door above the per-kind row instead of sitting inside
  // `Log food`. `usualRoutineDayOffers` gates on the bundle's reach and then on the food
  // half, so a day with no habit standing returns before it touches intake at all.
  const usualOffers = canWrite
    ? usualRoutineDayOffers(actingProfileId, day ?? todayStr)
    : [];
  const subjectNames: Record<number, string> = {};
  if (everyone) {
    for (const profile of scope.profiles) {
      if (viewIds.includes(profile.id)) subjectNames[profile.id] = profile.name;
    }
  }

  // ── THE DAY VIEW'S INHERITANCE (#3958 phase 2; #1068/#1425/#799) ─────────
  //
  // `/history?day=` is the app's one "that day" anchor now, so the three things
  // `/timeline`'s single-day view carried come with it: the intraday panel, the day
  // context chips, and the prev/next nav with its swipe.
  //
  // SINGLE-SUBJECT ONLY, which is the timeline's own rule and not a simplification:
  // daylight, UV, weather and cycle phase are ONE body's context, and a merged
  // household day cannot say whose. `?view=everyone&day=` still lists the rows — it
  // just draws no context, exactly as the merged feed did.
  const dayContext = day != null && !everyone ? day : null;
  const home = dayContext ? getHomeLocation(actingProfileId) : null;
  const profileTimezone = getTimezone(actingProfileId);
  const daylightOutdoor =
    dayContext && home
      ? (getDaylightOutdoorMinutesByDay(actingProfileId, [dayContext]).get(
          dayContext
        ) ?? 0)
      : 0;
  // UV rides on daylight: the dose reader is only asked about a day that HAS outdoor
  // minutes, which is the same gate the scrolling feed applied per row.
  const dayUv =
    dayContext && home && daylightOutdoor > 0
      ? (() => {
          const dose = getUvDoseForDays(actingProfileId, [dayContext]).get(
            dayContext
          );
          return dose && dose.uvSource === "live"
            ? { uvMinutes: dose.uvMinutes, peakUvIndex: dose.peakUvIndex }
            : null;
        })()
      : null;
  // WEATHER CONTEXT (#1728), quiet by default and notable by exception. The series is
  // widened backwards by the same lookback the feed used, because a spell's leading
  // days are what let the predicates see the run at all — asking for one day's row
  // would make a heatwave's third day look like an ordinary warm one.
  const dayWeather = (() => {
    if (!dayContext || !home) return null;
    const evaluated = evaluateSeries(
      getWeatherDaysForProfile(
        actingProfileId,
        shiftDateStr(dayContext, -WEATHER_SERIES_LOOKBACK_DAYS),
        dayContext
      )
    );
    return notableStatesSummary(evaluated.byDate.get(dayContext) ?? []) || null;
  })();
  // The cycle's answer for THIS day, resolved once: it decides both whether the chip
  // draws and whether the context strip has anything to hold.
  const cyclePeriods = dayContext ? listCyclePeriods(actingProfileId) : [];
  const dayCyclePhase = dayContext
    ? cyclePhaseOnDate(cyclePeriods, dayContext, todayStr)
    : null;
  const dayCyclePeriod = dayContext
    ? periodOnDate(cyclePeriods, dayContext, todayStr)
    : null;

  // TODAY'S UNARRIVED NIGHT, NAMED (#4918 ruling 7 / defect 4). #2097's one pure
  // decision, gathered by the SAME reader the dashboard row and the /sleep hero use,
  // so the day view cannot disagree with them about whether this profile is waiting.
  // TODAY ONLY: the window is clock-relative (wake anchor plus the measured arrival
  // lag), so it says nothing at all about a past day and is not asked there. Null on
  // the common day, which leaves the panel exactly as it was.
  //
  // RESOLVED BEFORE THE INTRADAY MODEL below, because the chart's expected-sleep
  // band (ruling 7) is gated on this same state — never a second decision.
  const sleepWaiting =
    day != null && day === todayStr
      ? (getSleepWaitingState(
          actingProfileId,
          getLastNightSummary(actingProfileId)?.wakeDay ?? null
        ) ?? undefined)
      : undefined;

  // THE EXPECTED SLEEP WINDOW (#4918 ruling 7) — the profile's typical bed/wake
  // pair, the SAME pair the dashboard's usual band already reads (#3253), fed to
  // the chart only while `sleepWaiting` says there is nothing real to draw yet.
  // Either boundary can fall below the 14-night gate and come back null; the model
  // treats "only one of the pair" as nothing to draw (see buildIntradayModel).
  const expectedSleep = sleepWaiting
    ? (() => {
        const bedMinutes = typicalBedTime(actingProfileId);
        const wakeMinutes = typicalWakeTime(actingProfileId);
        return bedMinutes != null && wakeMinutes != null
          ? { bedMinutes, wakeMinutes }
          : null;
      })()
    : null;

  // THE DAYLIGHT BAND'S SUNRISE/SUNSET (#4918 ruling 3) — the SAME solarDay
  // DaylightChip's own icon row reads, resolved once here for the chart's
  // background band. Gated exactly like the chip: both endpoints present, which
  // excludes a polar day/night (the chip's text line already says that honestly).
  const daylightBand = (() => {
    if (!dayContext || !home) return null;
    const day = solarDay(home.lat, home.lng, dayContext, profileTimezone);
    return day && day.sunriseMin != null && day.sunsetMin != null
      ? { sunriseMin: day.sunriseMin, sunsetMin: day.sunsetMin }
      : null;
  })();

  // THE INTRADAY PANEL (#1068) — the day rotated 90°. It reads the list this page
  // RESOLVED (`gather.dayEvents`), never a second query, which is what makes "a tick
  // can never name something the list below does not show" true by construction.
  //
  // ALWAYS a model now (#4918's empty-day ruling): a quiet day still gets one, with
  // its four data layers all empty, so the card below can still draw the daylight
  // band and its context line. Null here means only "no day is open at all"
  // (`dayContext`), never "nothing happened".
  const intraday = dayContext
    ? getIntradayDay(
        actingProfileId,
        dayContext,
        feeds[0]?.gather.dayEvents ?? [],
        {
          solarDay: daylightBand,
          expectedSleep,
        }
      )
    : null;

  // WHETHER THE DAY'S LOG ROWS COLLAPSE (#3958 phase 2).
  //
  // EVERYTHING ONLY, and the two exclusions are the issue's own words. "Filtered to a
  // family, the page behaves as the plain record": a reader who asked for Logs is
  // asking for the rows, and a rollup would answer by hiding them. "Day-view rows are
  // flat — no rollups; a day view lists everything": the day view is the surface you
  // open to see the whole day, so collapsing it there would defeat the visit.
  const rollup = day == null && kind == null && family == null;

  // ONE DAY GROUP, wherever it lands: in the recent band, or nested under the fold that
  // was holding it. Written once because the fold arrangement renders it from three
  // places (recent, an open month, an open month inside an open year), and three copies
  // of a sticky header is how two of them drift.
  //
  // `nested` MATCHES `FoldCard`'s OWN FLAG, not a new idea (#4365). A month card inside
  // an open year carries `pl-4` because it is a level down; the days that card reveals
  // are that level's CONTENTS, so they carry the identical `pl-4` — same left inset,
  // same class, so the two boxes' left edges are the same number by construction and
  // not by two authors agreeing on 16px. A top-level month's days pass `nested={false}`,
  // same as their own un-inset card, so nothing here changes for them.
  const daySection = (group: (typeof days)[number], nested = false) => (
    <section
      key={group.date}
      id={`timeline-day-${group.date}`}
      data-testid="history-day"
      data-day-nested={nested ? "true" : undefined}
      className={`scroll-mt-24 pb-2 pt-1 ${nested ? "pl-4" : ""} ${dayGutter}`}
    >
      {/* THE DAY HEADER STICKS ON THE FEED, AND ONLY ON THE FEED (#4918 ruling 1).
          It is the "which day am I in" affordance for a page that lists MANY days.
          The day view has exactly one, so the answer belongs to that page's frame —
          `TimelineDayNav`'s centre slot, which is above the fold, present on a day
          with no rows at all, and not a link to the page already open. Rendering
          both would put the same sentence twice on one screen; rendering this one
          only here is why the day view could stop drawing a self-linking chevron
          without losing the date.

          THE DAY HEADER STICKS, and it is the whole "which day am I in" affordance —
          there is no per-row date cell, which is most of what the one-line row buys.
          THE WHOLE TEXT CLUSTER IS THE DOOR and it carries a chevron (#4045 §7): the
          header shipped with only its date text linked and no chevron at all, so the
          count sat outside the tap target and nothing said the header was a door. The
          chevron sits IN the cluster — nothing is right-floated, per the spec's own
          words. (Phase 2 renders the day view; the link is already the real one.) */}
      {day == null ? (
        <h2 className="sticky top-edge-safe z-10 -mx-1 mb-1 bg-(--page) px-1 py-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {/* THE ONE RIGHTWARD DESTINATION CUE, not a hand-rolled chevron: the glyph and
            its geometry belong to the primitive (lib/__tests__/destination-link-primitive
            .test.ts refuses a raw one inside a link). Its `ml-auto` costs nothing here
            because the link is `inline-flex` and sized to its own content — the cue
            sits IN the text cluster, and nothing is right-floated. */}
          <DestinationLink
            // THE READER'S OWN BOUND RIDES ACROSS. Without `show` a day opened at
            // `HISTORY_DEFAULT_SHOW`, so a busy day truncated on first open even though
            // the page it was opened from had already been widened.
            href={historyHref({
              day: group.date,
              everyone,
              show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
            })}
            className="inline-flex items-baseline gap-2 hover:underline"
            data-testid="history-day-link"
          >
            <span>{formatLongDate(group.date, prefs)}</span>
            {/* THE SEPARATOR IS LOAD-BEARING, not decoration. #3958 writes this header
              as "FRI, AUG 28 — 15 records" and the implementation dropped the dash;
              with the count promoted INSIDE the link (above), the two spans then sat
              adjacent with nothing between them, so the cluster's `textContent` read
              "…August 295 records" — the date's last digit running into the count's
              first. `gap-2` separates them for an eye and for nothing else: anything
              reading the cluster linearly sees one run. That is not hypothetical —
              e2e/machine-date-census.spec.ts finds this header by matching a display
              date with `\d{1,2}\b`, and "29" followed by "5" has no word boundary
              after it, so its positive control stopped being able to see a date here
              at all. Restoring the dash puts the rendered shape back to the spec's
              own and makes the text content honest in the same stroke. */}
            <span aria-hidden className="text-slate-500 dark:text-slate-400">
              —
            </span>
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {group.events.length} record
              {group.events.length === 1 ? "" : "s"}
            </span>
          </DestinationLink>
        </h2>
      ) : null}
      <HistoryRows
        rows={
          layoutHistoryDay(group.events as HistoryRow[], { rollup }).visible
        }
        rollups={layoutHistoryDay(group.events as HistoryRow[], {
          rollup,
        }).rollups.map((line) => ({
          ...line,
          href: expandHref(line.key),
          open: expanded.has(line.key),
        }))}
        writableProfileIds={writableProfileIds}
        doseItems={doseItems}
        maxDates={maxDates}
        defaultTime={defaultTime}
        subjectNames={subjectNames}
        rowClassName={rowGutter}
        // A VIEW NARROWED TO ONE KIND DRAWS NO GLYPH COLUMN (#4045 §3), extending
        // #3958's rule that the column collapses in views that render no glyphs. Asked
        // of the VIEW and not of the rows: All is still All when a profile happens to
        // have logged only food this week, and its next row could be any kind.
        showGlyphs={kind == null}
      />
    </section>
  );

  const rowCount = renderedDays.reduce((n, d) => n + d.events.length, 0);
  const hasMore = feeds.some((feed) => feed.gather.hasMore);

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="history-page"
    >
      {/* NO SUBTITLE ON THE DAY VIEW (#4918 ruling 5). "Everything recorded, newest
          first." describes the FEED — a day view is one day, and the day bar under
          this header already says which. On the day view it was a sentence about a
          different page sitting above the day's own name. */}
      <PageHeader
        title="History"
        subtitle={day ? undefined : "Everything recorded, newest first."}
        compactBelowSm
        className={railGutter}
      />

      {/* ONE FILTER ROW, AND IT IS ONE LINE. Kind chips on the shared responsive
          pill group (#3938's control box, phone-scroll / `sm`-wrap), data-presence
          earned so an empty category never advertises itself, plus the Photos toggle
          behind a hairline — a cross-cutting filter, never a renderer switch. No
          counts on chips: the day headers count. A WRAPPING row was the first thing
          that blew the chrome budget here, which is why the kinds scroll and the
          toggle is pinned outside the scroller rather than wrapping under it.

          Phase 1 renders the Logs family's KIND row directly rather than a family row
          that would hold one entry; `?family=` still resolves.

          `gap-3` on both control rows, which is the gap `FilterPills` already spends
          between its own pills: the reach a coarse pointer gets around a 34px box is
          (44 - 34) / 2 per side, so two adjacent extended targets need TWICE that
          between them, and #3938 made `gap-3` the one gap every pill layout uses.
          MEASURED HONESTLY: `gap-2` here also cleared the floor, because the hairline
          divider sits between the two clusters and is itself gapped on both sides —
          so this is agreement with the shared row, not a defect that was found. */}
      <div
        className={`mb-3 flex items-center gap-3 ${railGutter}`}
        data-testid="history-filters"
      >
        <div className="min-w-0 flex-1">
          {/* THE FAMILY ROW (#3958 phase 2): All · Logs · Training · Clinical · Life.
              Phase 1 rendered the Logs KIND row here because Logs was the only family
              that existed; with four, the top row is families and the kinds move to
              the refinement row below. Still ONE row in the header stack — the
              refinement row renders only inside a family, never in All, so the chrome
              budget above the first record is unchanged in the view that has to meet
              it. */}
          <FilterPills
            mode="link"
            layout="responsive"
            linkBehavior="timeline"
            label="Filter the record by family"
            value={activeFamily}
            testId="history-family-pills"
            options={[
              {
                value: null,
                label: "All",
                href: chipHref({ kind: undefined, family: undefined }),
                testId: "history-chip-all",
              },
              ...presentFamilies.map((candidate) => ({
                value: candidate as HistoryFamily | null,
                label: HISTORY_FAMILY_LABELS[candidate],
                href: chipHref({ kind: undefined, family: candidate }),
                testId: `history-chip-family-${candidate}`,
              })),
            ]}
          />
        </div>
        {/* THE PINNED CLUSTER, behind one hairline: the controls that do not
            scroll with the family pills. Photos is a cross-cutting FILTER;
            Calendar is a DOOR — the month grid #4102 moved off the nav and onto
            the page whose subject is which day a thing happened. Both ride the
            control box the pills already spend, so this row is exactly as tall
            with them as without, which is what lets the grid land on a page
            whose chrome above its first record is bounded at ~140px. */}
        <span
          aria-hidden
          className="h-5 w-px shrink-0 bg-black/10 dark:bg-white/10"
        />
        {hasMedia || mediaApplied ? (
          <span className="shrink-0">
            <Chip
              role="filter"
              href={chipHref({ media: !mediaApplied })}
              current={mediaApplied}
              linkBehavior="timeline"
              testId="history-chip-media"
            >
              Photos
            </Chip>
          </span>
        ) : null}
        {/* EVERY DAY THE VIEWED MEMBERS HAVE AN EVENT ON, and this is the ONE
            place the union is read now (#4280). It rode in the app shell while
            the sidebar and the drawer both mounted the grid, which spent ~20
            queries on every page in the app to mark days on two surfaces most
            visits never opened.

            THE MARKS FOLLOW THE FEED'S VIEW-SET, not the acting profile (#4393
            ruling 3). `memberIds` is the SAME resolution the gather above runs
            on — one member, or the household under `?view=everyone` — so the
            calendar cannot answer "whose days are these" differently from the
            feed it navigates. It carried the nav mount's acting-profile answer
            until now, which read as one body's marks beside a merged record.
            Under `?view=everyone` that is ~20 queries per viewed member on this
            page; single view is unchanged. */}
        <EventCalendar
          eventDates={memberIds.flatMap((id) => getTimelineDates(id))}
          everyone={everyone}
        />
      </div>

      {/* THE KIND-SCOPED REFINEMENT ROW, PER FAMILY — "never in All" (#3958). It is a
          SECOND row and it only exists once the reader has already chosen a family, so
          the ≤140px chrome budget is measured where it is stated: on the page as it
          first loads, which is All. Every chip is presence-earned from the same answer
          the family row used, so a family cannot offer a kind it has no rows for. */}
      {activeFamily ? (
        <div className={`mb-3 ${railGutter}`} data-testid="history-kind-row">
          <FilterPills
            mode="link"
            layout="responsive"
            linkBehavior="timeline"
            label={`Filter ${HISTORY_FAMILY_LABELS[activeFamily]} by kind`}
            value={kind ?? null}
            testId="history-kind-pills"
            options={[
              {
                value: null,
                label: HISTORY_FAMILY_LABELS[activeFamily],
                href: chipHref({ kind: undefined, family: activeFamily }),
                testId: `history-chip-${activeFamily}-all`,
              },
              ...HISTORY_FAMILY_KINDS[activeFamily]
                .filter((candidate) => presentKinds.includes(candidate))
                .map((candidate) => ({
                  value: candidate as HistoryKind | null,
                  label: HISTORY_KIND_LABELS[candidate],
                  href: chipHref({ kind: candidate }),
                  testId: `history-chip-${candidate}`,
                })),
            ]}
          />
        </div>
      ) : null}

      {/* ADJACENT-DAY NAVIGATION (#1425), on the view that HAS neighbours. Both
          destinations are built HERE, on the server, through the one grammar helper —
          never client date arithmetic, because which calendar day is "yesterday"
          depends on the profile's timezone. The component renders the arrows AND owns
          the horizontal swipe that follows them, so the two can never disagree.

          THE READER'S FILTER RIDES ACROSS. Walking from one day to the next inside
          `?kind=dose` stays inside it; the day changes and nothing else does.

          NEVER PAST TODAY (#3958's edge-case ruling: "day nav cannot advance past
          today"). `clampHistoryDay` clamps a future `?day=` on arrival, so a next
          arrow into tomorrow would land back on today — an arrow that visibly does
          nothing. ON TODAY THERE IS NO `next` AT ALL, and until #4918 that was true
          only of this comment: the code passed `dayNavHref(day)`, so today's right
          arrow was a link to today, labelled today, and the swipe followed it. The
          destination is optional now, so the arrow and the gesture are the same
          fact and the comment cannot drift from the code again.

          AND THE BAR NAMES THE DAY (#4918 ruling 1), in #3958's header grammar and
          with the count the header carried — "0 records" included, because a day
          with nothing on it is exactly the day that named no day at all. */}
      {day ? (
        <TimelineDayNav
          prev={{
            href: dayNavHref(shiftDateStr(day, -1)),
            label: formatMonthDay(shiftDateStr(day, -1), prefs),
          }}
          next={
            day < todayStr
              ? {
                  href: dayNavHref(shiftDateStr(day, 1)),
                  label: formatMonthDay(shiftDateStr(day, 1), prefs),
                }
              : undefined
          }
          day={`${formatLongDate(day, prefs)} — ${rowCount} record${
            rowCount === 1 ? "" : "s"
          }`}
          targetSelector="main"
        />
      ) : null}

      {/* THE DAY AT A GLANCE (#1068), above the list it maps. Rendered from the
          resolved row set rather than a second gather — see `HistoryGather.dayEvents`
          — so the chart cannot show a mark for something the list below dropped.

          DIRECTLY UNDER THE DAY BAR (#4918 ruling 2). It used to sit below the add
          layer, so the day's own content had the weakest position on its own page:
          three frames of three styles stacked above the record. The chart is the
          day's content — #3958 lists it beside the rows — so it does not spend the
          chrome budget above the first record, and the add layer it swapped with is
          now directly above the rows it creates (#4832's offers-first order inside
          that layer is unchanged).

          THE CARD ALWAYS RENDERS (#4918's empty-day ruling and ruling 3). The
          standalone `history-day-context` strip retired into the card's own context
          line — daylight, UV, cycle phase and weather, body context for ONE body, so
          it only has anything to say on a single-subject day (`?view=everyone&day=`
          still lists the rows and simply draws no chips, the merged feed's own rule).
          Each chip stays quiet by default (`DaylightChip` draws nothing without a
          home location, `CyclePhaseChip` nothing off a cycle), so a quiet Tuesday
          draws no context row at all — but the CARD itself, and the daylight band
          on the plot, draw regardless: `intraday` is non-null whenever a day is
          open (see above), rows or none. */}
      {intraday ? (
        // ONE ZOOM AND ONE CROSSHAIR FOR THE DAY (#4950). The panel mounts the chart
        // twice — compact and wide, both in the DOM at once — and the add row below is
        // about to read "the current view" off them. Two owners would mean two views
        // and no way for this page to know which variant the viewport is showing, so
        // the state lives here and both charts read it.
        <IntradayInteractionProvider>
          <div className={railGutter}>
            <IntradayPanel
              model={intraday}
              formatPrefs={prefs}
              profileId={actingProfileId}
              home={home}
              timezone={profileTimezone}
              daylightOutdoor={daylightOutdoor}
              uv={dayUv}
              cyclePhase={dayCyclePhase}
              cyclePeriod={dayCyclePeriod}
              weather={dayWeather}
              waiting={sleepWaiting}
              waitingDetail={
                sleepWaiting
                  ? sleepWaitingDetail(sleepWaiting, {
                      clock: (min) => formatClockMinutes(prefs.timeFormat, min),
                      when: (iso) => formatRelativeTime(iso),
                    })
                  : null
              }
              selectedWindow={chartWindow}
            />
          </div>
        </IntradayInteractionProvider>
      ) : null}

      {/* THE ADD LAYER SITS ABOVE THE ROWS IT CREATES (#4918 ruling 2) — under the
          chart, not above it.

          THE ADD DOOR, KIND-RESOLVED. Filtered to a kind it IS that kind's backfill,
          MOUNTED IN PLACE — the form opens here rather than sending the reader to the
          domain surface, which is what #3958 asked for and what only the dose kind
          shipped (#4045 §1). Log kinds only — clinical, training and life records are
          created on their own surfaces — and never the future: every door here is
          bounded by today. */}
      {canWrite ? (
        <div className={`mb-2 text-sm ${railGutter}`} data-testid="history-add">
          {/* THE OFFERS LINE FIRST (#4310 ruling), before the per-kind grammar below it,
              and silent on a day with no standing offer. */}
          <HistoryUsualOffers offers={usualOffers} date={day ?? todayStr} />
          {!hasAddDoor ? (
            /* IN ALL — AND IN A KIND WITH NOTHING TO OFFER — THE DOOR ASKS THE KIND
               FIRST, which on a record page is the same act as narrowing to it. It
               scrolls rather than wraps for the same reason the filter row does. */
            /* SYMPTOM IS EXEMPT FROM THE PRESENCE GATE (#4851 owner ruling) —
               `historyAddKinds` is the one computation that knows it, so the exemption
               cannot drift out of step with the rest of the gate. The row itself is a
               client component (#4950): it reads the window the chart is showing and
               adds it to the params these rules produced. */
            <HistoryAddRow
              timeFormat={prefs.timeFormat}
              chips={historyAddKinds(presentKinds).map((candidate) => ({
                kind: candidate,
                label: HISTORY_KIND_LABELS[candidate],
                params: chipHrefParams({ kind: candidate }),
              }))}
            />
          ) : addVocabulary && addKind ? (
            <HistoryAddDoor
              kind={addKind}
              // THE DAY THE READER WAS LOOKING AT. Finding a gap is the reason to open
              // this door at all, so the form opens on that day rather than on today —
              // the context the redirect used to throw away.
              date={day ?? todayStr}
              maxDate={todayStr}
              vocabulary={addVocabulary}
            />
          ) : null}
        </div>
      ) : null}

      {/* THE TWO EMPTY STATES ARE DIFFERENT MESSAGES (#1410), and the difference is
          the whole design: an EMPTY ACCOUNT is fixed by putting data in, a FILTERED
          view is fixed by widening the filter. Offering "log an activity" to someone
          who just tapped the Immunizations chip answers a question they did not ask.

          INHERITED, NOT INVENTED. This shipped on `/timeline` and the phase-1
          re-housing brought the messages across without the DOORS — a gap nothing
          caught, because the spec that asserts them was still pointed at the route
          that still had them. Deleting the route is what surfaced it. */}
      {rowCount === 0 ? (
        kind || family || media || day ? (
          /* ON THE DAY VIEW THE EMPTY STATE IS COMPACT AND SAYS WHAT IT MEANS
             (#4918 ruling 5). A `p-10` dashed card reading "Nothing recorded here
             yet." was the LARGEST element on a quiet day — and on today it sat
             under a chart already drawing six hours of recorded heart rate, so its
             copy contradicted the thing above it. "No entries" is about the ROWS,
             which is all this panel ever spoke for. */
          <EmptyState
            testId="history-empty-filtered"
            compact={day != null}
            message={
              day == null
                ? "Nothing recorded here yet."
                : day === todayStr
                  ? "No entries yet today."
                  : "No entries."
            }
          />
        ) : (
          <EmptyState
            testId="history-empty"
            message="Nothing recorded yet. Anything logged shows up here."
            // The training door is gated on the SUBJECT's life stage, exactly as the
            // timeline gated it: a next action the profile cannot take is worse than
            // one fewer door.
            actions={TIMELINE_EMPTY_ACTIONS.filter(
              (action) =>
                isTrainingRelevant(getProfileAge(actingProfileId)) ||
                !action.href.startsWith("/training")
            )}
          />
        )
      ) : null}

      {/* THE FEED CONTAINER TAKES NO RAIL GUTTER, and that is the #3920 shape rather
          than an oversight: below `sm` the row band is FULL-BLEED, so a gutter on its
          container would stop the fill reaching the edge and leave a 28px strip of
          page beside it. The rail's lane is spent by the row CONTENT and by the day
          headers instead — "the band fill stays full-bleed while row content ends
          short of the edge". */}
      <div data-testid="history-feed">
        {(windowed ? windowed.recent : days).map((group) => daySection(group))}
        {/* READING ORDER: the recent band first, then this year's older months, then
            one card per earlier year. A fold card above the days would put a stack of
            shut doors between the reader and their own recent history, which is the
            defect #2657 exists to prevent — and it would spend the chrome budget on
            content nobody asked to see.

            AN OPEN MONTH'S DAYS RENDER RIGHT HERE, UNDER ITS OWN CARD (#4045 §4), which
            is the arrangement the retired `/timeline` always had. Shipped, this page appended
            every open month's days to the day feed ABOVE the whole fold stack, so a tap
            revealed content nowhere near the card that revealed it: with the scroll
            preserved, the reader was left looking at a card that had visibly done
            nothing but rotate a chevron. Chronological order is unchanged — the fold
            stack is newest-first and so are each fold's days, so this is a re-nesting
            and not a re-ordering — and with the fold card holding its place, opening
            lands the revealed days directly beneath the tap and closing leaves the
            reader on the card they tapped. */}
        {windowed?.months.map((fold) => (
          <Fragment key={fold.key}>
            <HistoryFoldCard
              fold={fold}
              gutter={railGutter}
              href={foldHref(fold.key)}
            />
            {fold.open ? fold.days.map((group) => daySection(group)) : null}
          </Fragment>
        ))}
        {windowed?.years.map((year) => (
          <Fragment key={year.key}>
            <HistoryFoldCard
              fold={year}
              gutter={railGutter}
              href={foldHref(year.key, {
                open: year.open,
                descendants: year.months.map((month) => month.key),
              })}
            />
            {year.open
              ? year.months.map((month) => (
                  <Fragment key={month.key}>
                    <HistoryFoldCard
                      fold={month}
                      gutter={railGutter}
                      href={foldHref(month.key)}
                      nested
                    />
                    {month.open
                      ? month.days.map((group) => daySection(group, true))
                      : null}
                  </Fragment>
                ))
              : null}
          </Fragment>
        ))}
      </div>

      {/* LOAD MORE, OR THE SENTENCE THAT SAYS WHY THERE ISN'T ONE.
          `?show` is clamped at `HISTORY_MAX_SHOW`, so at the ceiling the control was a
          button whose URL changed and whose page did not. A control that does nothing
          is worse than no control, because it answers "is there more" with a promise
          instead of a fact.

          AND SO IS A SENTENCE THAT NAMES A ROUTE BACK TO THE SAME ROWS. This said
          "Narrow to one kind, or open a day, to read further back", and the first half
          was FALSE: `limit` is applied per kind inside the gather — `wants()` decides
          WHETHER a kind is read, never how much — so the All view already reads every
          kind to `show`, and the chip carries `show` across, landing the narrowed view
          on the identical rows. Measured: 0 rows revealed, same oldest date either
          side. That is worse than the inert button it replaced, because it spends the
          reader's trust as well as their tap.

          So the page says only what it knows: how much it is showing. The ceiling
          stays — it is what keeps one kind's read off the whole store — and phase 2's
          day view is where "further back" gets a real answer. */}
      {hasMore ? (
        <div className={`mt-4 ${railGutter}`}>
          {show < HISTORY_MAX_SHOW ? (
            <Link
              className="btn-ghost btn-sm"
              data-testid="history-load-more"
              href={historyHref({
                family: kind ? undefined : family,
                kind,
                class: doseClass,
                item: rawItem,
                media: mediaApplied,
                day,
                everyone,
                open: [...openFolds],
                expand: [...expanded].sort(),
                show: Math.min(show + HISTORY_SHOW_STEP, HISTORY_MAX_SHOW),
              })}
            >
              Load more
            </Link>
          ) : (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="history-show-ceiling"
            >
              {`Showing the most recent ${HISTORY_MAX_SHOW} records.`}
            </p>
          )}
        </div>
      ) : null}

      {stops.length > 0 ? <JumpRailScrubber stops={stops} /> : null}
    </PageContainer>
  );
}
