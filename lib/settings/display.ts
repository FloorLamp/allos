import * as React from "react";
import { db, writeTx } from "../db";

// React's per-request cache() only exists in the canary React that Next vendors
// for server components. This module is also imported directly by tsx scripts
// (scripts/notify.ts) that resolve the plain `react` package, which doesn't export
// cache — importing the named binding there crashes at module load. Fall back to
// identity in that context (those scripts run each read at most once per tick, so
// per-request dedup is meaningless outside Next). Mirrors lib/request-cache.ts.
const cache: typeof React.cache =
  (React as { cache?: typeof React.cache }).cache ?? ((fn) => fn);
import { isValidTimezone, resolveTimezone } from "../timezone";
// Type-only import so lib/settings ↔ lib/dashboard-widgets stays a compile-time
// edge (no runtime cycle: dashboard-widgets imports nothing back from settings).
import type { DashboardLayout } from "../dashboard-widgets";
import { parseViews, serializeViews, type TrendView } from "../trend-views";
import {
  getSetting,
  getProfileSetting,
  setProfileSetting,
  getLoginSetting,
  setLoginSetting,
} from "./kv";

// Date/time display preferences (#964) are the login-tier siblings of the unit
// prefs. The enum types + pure formatters live in lib/format-date (client-safe, no
// DB); this module only resolves the stored login_settings values into that shape.
export type {
  TimeFormat,
  DateFormat,
  DisplayFormatPrefs,
} from "../format-date";
import { DEFAULT_FORMAT_PREFS, type DisplayFormatPrefs } from "../format-date";

export type WeightUnit = "kg" | "lb";
export type DistanceUnit = "km" | "mi";
// Body temperature is stored canonically in °F (see lib/vitals-input.ts). The unit
// here is a DISPLAY preference only — no reading is ever stored in °C.
export type TemperatureUnit = "F" | "C";

export interface UnitPrefs {
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
  temperatureUnit: TemperatureUnit;
}

const DEFAULTS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
};

// ---- Unit display preferences (per login) ----
// Wrapped in React `cache()` — a single render calls this many times (~4×/Training
// view, and once per unit-formatting boundary elsewhere), all for the same login.
// Request-scoped memoization collapses those to one pair of reads. Safe: the only
// writer (setUnitPrefs / saveUnitPrefs) revalidates rather than re-reading in the
// same request, and outside a request `cache()` degrades to a plain passthrough.
export const getUnitPrefs = cache(function getUnitPrefs(
  loginId: number
): UnitPrefs {
  const weight = getLoginSetting(loginId, "weight_unit");
  const distance = getLoginSetting(loginId, "distance_unit");
  const temperature = getLoginSetting(loginId, "temperature_unit");
  return {
    weightUnit: weight === "lb" ? "lb" : DEFAULTS.weightUnit,
    distanceUnit: distance === "mi" ? "mi" : DEFAULTS.distanceUnit,
    temperatureUnit: temperature === "C" ? "C" : DEFAULTS.temperatureUnit,
  };
});

export function setUnitPrefs(loginId: number, prefs: UnitPrefs) {
  writeTx(() => {
    setLoginSetting(loginId, "weight_unit", prefs.weightUnit);
    setLoginSetting(loginId, "distance_unit", prefs.distanceUnit);
    setLoginSetting(loginId, "temperature_unit", prefs.temperatureUnit);
  });
}

// ---- Date/time display preferences (per login, #964) ----
// A login's chosen clock (12h/24h) and date shape (mdy/dmy/iso), the display-tier
// sibling of the unit prefs. Stored per login in login_settings; read defensively so
// any unknown/legacy value falls back to DEFAULT_FORMAT_PREFS — which reproduces
// today's dominant rendering (24h; "Mon D, YYYY"). cache()-wrapped like getUnitPrefs
// (a single render resolves it once per formatting boundary).
export const getDisplayFormatPrefs = cache(function getDisplayFormatPrefs(
  loginId: number
): DisplayFormatPrefs {
  const time = getLoginSetting(loginId, "time_format");
  const date = getLoginSetting(loginId, "date_format");
  return {
    timeFormat: time === "12h" ? "12h" : DEFAULT_FORMAT_PREFS.timeFormat,
    dateFormat:
      date === "dmy" || date === "iso" ? date : DEFAULT_FORMAT_PREFS.dateFormat,
  };
});

export function setDisplayFormatPrefs(
  loginId: number,
  prefs: DisplayFormatPrefs
): void {
  writeTx(() => {
    setLoginSetting(loginId, "time_format", prefs.timeFormat);
    setLoginSetting(loginId, "date_format", prefs.dateFormat);
  });
}

// App timezone (IANA name, e.g. "America/New_York"), stored per profile in
// profile_settings and falling back to the instance default (global settings
// 'timezone', seeded once from the TZ env), then UTC. This is the source of truth
// for a profile's day boundaries — today()/yesterday(), rolling day-windows,
// streaks, and notification scheduling all resolve to it. NOTE: lib/db.ts inlines
// this same read (it can't import settings.ts without a cycle); keep them in sync
// via the shared lib/timezone.resolveTimezone.

export function getTimezone(profileId: number): string {
  // Per-profile setting wins; read the instance default only when it's unset (the
  // `??` short-circuit), then resolveTimezone validates-or-falls-back to UTC.
  const prof = getProfileSetting(profileId, "timezone");
  return resolveTimezone(
    prof,
    prof == null ? getSetting("timezone") : undefined
  );
}

export function setTimezone(profileId: number, tz: string): void {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  setProfileSetting(profileId, "timezone", tz);
}

// ---- Week start (per profile) ----
// The first day of the week (0=Sun … 6=Sat), stored per profile. Decides where
// calendar grids/weekly charts break and when the weekly-routine counters reset.
// Defaults to Sunday.
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DEFAULT_WEEK_START: WeekStart = 0;

export function isValidWeekStart(n: number): n is WeekStart {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

export function getWeekStart(profileId: number): WeekStart {
  const n = Number(getProfileSetting(profileId, "week_start"));
  return isValidWeekStart(n) ? n : DEFAULT_WEEK_START;
}

export function setWeekStart(profileId: number, weekStart: WeekStart): void {
  if (!isValidWeekStart(weekStart))
    throw new Error(`Invalid week start: ${weekStart}`);
  setProfileSetting(profileId, "week_start", String(weekStart));
}

// ---- Weekly counting mode (per profile) ----
// Whether the weekly-routine counters and the journal week summary count over the
// current calendar week (resetting on the week-start day) or a rolling 7-day
// window. Defaults to the calendar week, so the week-start preference drives them
// out of the box.
export type WeekMode = "calendar" | "rolling";

export const DEFAULT_WEEK_MODE: WeekMode = "calendar";

export function isValidWeekMode(v: string): v is WeekMode {
  return v === "calendar" || v === "rolling";
}

export function getWeekMode(profileId: number): WeekMode {
  const v = getProfileSetting(profileId, "week_mode");
  return v && isValidWeekMode(v) ? v : DEFAULT_WEEK_MODE;
}

export function setWeekMode(profileId: number, mode: WeekMode): void {
  if (!isValidWeekMode(mode)) throw new Error(`Invalid week mode: ${mode}`);
  setProfileSetting(profileId, "week_mode", mode);
}

// ---- Free days (per profile, issue #1241) ----
// The days of the week (0=Sun … 6=Sat) the person is OFF work/school — their
// "free days". Social-jetlag in lib/sleep-regularity splits nights into free-day
// vs work-day wake-mornings; the weekend guess (Sat/Sun) is wrong for shift
// workers/nurses, so this makes the partition per-profile. Default is Sat/Sun so
// an existing profile's figure doesn't move. An EXPLICITLY empty set (the row
// present with no days) is honored as "no free days"; only an ABSENT row falls
// back to the default. Stored as a sorted comma-joined string in profile_settings.
export const DEFAULT_FREE_DAYS: readonly number[] = [0, 6]; // Sun + Sat

// Normalize an arbitrary day list to a sorted, de-duplicated array of valid
// weekday indices (0..6). Pure — shared by the setter and any caller building the
// stored value, so a bad input can never persist.
export function normalizeFreeDays(days: number[]): number[] {
  const set = new Set<number>();
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d);
  }
  return [...set].sort((a, b) => a - b);
}

export function getFreeDays(profileId: number): number[] {
  const raw = getProfileSetting(profileId, "free_days");
  if (raw == null) return [...DEFAULT_FREE_DAYS];
  // An explicit empty string means "no free days" — honored, not defaulted.
  if (raw.trim() === "") return [];
  return normalizeFreeDays(raw.split(",").map((s) => Number(s.trim())));
}

export function setFreeDays(profileId: number, days: number[]): void {
  setProfileSetting(profileId, "free_days", normalizeFreeDays(days).join(","));
}

// The retired `trend_pins` accessors lived here until #1456 folded that KV into the
// `saved_items` table (migration 113 deletes the settings rows); the save store's
// reads/writes are lib/queries/saved.ts, not a settings tier.

// Saved views — named snapshots of the Trends hub state
// (range + tab + compare pair), stored as a JSON array in profile_settings
// (key "trend_views"). The list math (add/rename/
// delete/normalize) lives in the pure lib/trend-views; this tier only
// (de)serializes it. Reads defensively — a malformed blob yields an empty list.
export function getTrendViews(profileId: number): TrendView[] {
  return parseViews(getProfileSetting(profileId, "trend_views"));
}

export function setTrendViews(
  profileId: number,
  views: readonly TrendView[]
): void {
  setProfileSetting(profileId, "trend_views", serializeViews(views));
}

// Per-profile, per-TAB Trends card arrangement (#1490 — the override half).
//
// A ranked DEFAULT order (lib/trends-card-rank.ts) serves a profile that has never
// arranged a tab. The moment a user drags a card, THEIR order wins permanently and
// nothing re-ranks it — the whole point of chart cards being a place, not a feed.
// This is the storage for that arrangement.
//
// Storage shape follows the `dashboard_layout` precedent (a defensively-parsed JSON
// blob in profile_settings) rather than `saved_items`: saved_items answers Overview
// MEMBERSHIP (#1487 — which tiles a profile pinned), a different question from a
// tab's card SEQUENCE. One key holds every tab, so a new tab needs no new key.
// Ids are NOT validated against the registry — `mergeStoredOrder` drops unknown
// ids and appends unseen ones at their ranked position, so a client on an older or
// newer catalog can never corrupt the rest.
export type TrendsCardArrangements = Record<string, string[]>;

function parseArrangements(
  v: string | null | undefined
): TrendsCardArrangements {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: TrendsCardArrangements = {};
    for (const [tab, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) continue;
      const clean = [
        ...new Set(
          ids
            .filter((x): x is string => typeof x === "string")
            .map((s) => s.trim())
            .filter(Boolean)
        ),
      ];
      if (clean.length > 0) out[tab] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

// Every stored per-tab arrangement for a profile.
export function getTrendsCardArrangements(
  profileId: number
): TrendsCardArrangements {
  return parseArrangements(getProfileSetting(profileId, "trends_card_order"));
}

// One tab's stored arrangement, or null when the profile has never arranged it —
// null is what tells the ranker "you own this order".
export function getTrendsCardOrder(
  profileId: number,
  tab: string
): string[] | null {
  const stored = getTrendsCardArrangements(profileId)[tab];
  return stored && stored.length > 0 ? stored : null;
}

// Persist (or clear, with an empty list) one tab's arrangement, leaving the other
// tabs untouched.
export function setTrendsCardOrder(
  profileId: number,
  tab: string,
  ids: readonly string[]
): void {
  const all = getTrendsCardArrangements(profileId);
  const clean = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  if (clean.length === 0) delete all[tab];
  else all[tab] = clean;
  setProfileSetting(profileId, "trends_card_order", JSON.stringify(all));
}

// Per-profile dashboard customization — the widget order + hidden
// set, stored as a JSON blob (same key/value precedent as active situations).
// Read defensively: any malformed/legacy shape returns null so the page falls
// back to the registry defaults rather than throwing. The layout is merged
// against the live registry by resolveWidgets, so ids are not validated here.
export function getDashboardLayout(profileId: number): DashboardLayout | null {
  const v = getProfileSetting(profileId, "dashboard_layout");
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== "object") return null;
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((x: unknown): x is string => typeof x === "string")
      : [];
    return { order, hidden };
  } catch {
    return null;
  }
}

// Persist the layout, trimming/deduping both lists so a corrupt post can't bloat
// the blob. Ids aren't validated against the registry (resolveWidgets merges
// defensively), so a client on an older/newer catalog never wipes the rest.
export function setDashboardLayout(
  profileId: number,
  layout: DashboardLayout
): void {
  const clean = (ids: string[]): string[] => [
    ...new Set(ids.map((s) => s.trim()).filter(Boolean)),
  ];
  const normalized: DashboardLayout = {
    order: clean(layout.order),
    hidden: clean(layout.hidden),
  };
  setProfileSetting(profileId, "dashboard_layout", JSON.stringify(normalized));
}

// Per-viewer illness-hero UI state (issue #858): whether the acting profile's own
// cockpit is collapsed to its one-line headline, and which OTHER accessible profile's
// accordion cockpit is expanded (one at a time). Stored per acting profile in the same
// key/value store as the dashboard layout (a sibling UI-state blob, kept out of the
// order/hidden layout so the registry's defensive merge stays focused). The hero is
// COLLAPSIBLE, never hideable — this only remembers open/closed, never removes a cockpit
// while an episode is open. Read defensively: a malformed blob falls back to defaults.
export interface IllnessHeroUiState {
  collapsedActive: boolean;
  openOtherId: number | null;
}

export function getIllnessHeroUi(profileId: number): IllnessHeroUiState {
  const fallback: IllnessHeroUiState = {
    collapsedActive: false,
    openOtherId: null,
  };
  const v = getProfileSetting(profileId, "illness_hero_ui");
  if (!v) return fallback;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== "object") return fallback;
    const openOtherId =
      typeof parsed.openOtherId === "number" &&
      Number.isInteger(parsed.openOtherId)
        ? parsed.openOtherId
        : null;
    return { collapsedActive: parsed.collapsedActive === true, openOtherId };
  } catch {
    return fallback;
  }
}

export function setIllnessHeroUi(
  profileId: number,
  state: IllnessHeroUiState
): void {
  const normalized: IllnessHeroUiState = {
    collapsedActive: state.collapsedActive === true,
    openOtherId:
      typeof state.openOtherId === "number" &&
      Number.isInteger(state.openOtherId)
        ? state.openOtherId
        : null,
  };
  setProfileSetting(profileId, "illness_hero_ui", JSON.stringify(normalized));
}

// The dashboard "Needs attention" hero's collapse preference (issue #1413, section
// B). Per-LOGIN, not per-profile: it is a viewing-density choice about the reader's
// own screen (the same tier as their unit and date-format prefs), not a fact about
// the person whose health is being displayed — a caregiver who collapses the hero on
// their phone means it for every profile they switch between, and should not have to
// re-collapse it per family member.
//
// Stored as a plain "1"/"0" string rather than JSON: it is one boolean with no
// foreseeable second field, and the illness hero's JSON blob shape (setIllnessHeroUi)
// exists only because that one carries a profile id alongside its flag.
//
// Note what this setting canNOT do (#449): it never hides the hero, never removes
// the count, and never applies to a safety-locked hero — those are decided by
// attentionHeroState (lib/attention.ts), which consults this preference LAST.
export function getAttentionHeroCollapsed(loginId: number): boolean {
  return getLoginSetting(loginId, "attention_hero_collapsed") === "1";
}

export function setAttentionHeroCollapsed(
  loginId: number,
  collapsed: boolean
): void {
  setLoginSetting(loginId, "attention_hero_collapsed", collapsed ? "1" : "0");
}

// The dashboard "Recently resolved — reopen?" lines the VIEWER has dismissed (issue
// #1548), as a set of episode ids. Per-LOGIN, exactly like the attention hero's
// collapse preference above and for the same reason: this is a statement about the
// reader's own screen, not a fact about the person whose episode it is. Another login
// with access to the same profile still sees the line — deliberately.
//
// Why NOT the findings bus (`upcoming_dismissals`): the reopen line is a calm
// convenience, not a finding — it carries no dedupeKey, never reaches Upcoming, the
// digest, or a notification, and the #449 tiers stay untouched. Putting a viewer
// preference on the medical suppression bus would give it reach it must not have.
//
// Stored as a JSON array of integers rather than a flag-per-key, because the ids are
// a SET whose membership is pruned as a whole on every write (see
// dismissRecentlyResolvedEpisode). Read defensively — a hand-edited or older value
// must degrade to "nothing dismissed", never throw on the dashboard's render path.
export function getRecentlyResolvedDismissed(loginId: number): number[] {
  const raw = getLoginSetting(loginId, "recently_resolved_dismissed");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0
    );
  } catch {
    return [];
  }
}

// Replaces the stored set wholesale (the caller has already pruned it). Sorted so the
// stored value is stable across equivalent writes and diffable by eye.
export function setRecentlyResolvedDismissed(
  loginId: number,
  episodeIds: number[]
): void {
  const unique = [...new Set(episodeIds.filter((id) => Number.isInteger(id)))];
  unique.sort((a, b) => a - b);
  setLoginSetting(
    loginId,
    "recently_resolved_dismissed",
    JSON.stringify(unique)
  );
}
