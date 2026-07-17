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
import { parsePins, serializePins } from "../trend-pins";
import { parseViews, serializeViews, type TrendView } from "../trend-views";
import {
  getSetting,
  getProfileSetting,
  setProfileSetting,
  getLoginSetting,
  setLoginSetting,
} from "./kv";

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

// Pin-to-Trends — the profile's pinned Trends-Overview
// tiles (metric + biomarker keys), stored as a JSON array in profile_settings
// (same key/value precedent as active_situations / dashboard_layout). The list
// math (parse/toggle/order) lives in the pure lib/trend-pins; this tier only
// (de)serializes it. Reads defensively — a malformed blob yields an empty list.
export function getTrendPins(profileId: number): string[] {
  return parsePins(getProfileSetting(profileId, "trend_pins"));
}

export function setTrendPins(profileId: number, pins: readonly string[]): void {
  setProfileSetting(profileId, "trend_pins", serializePins(pins));
}

// Saved views — named snapshots of the Trends hub state
// (range + tab + compare pair + pins), stored as a JSON array in profile_settings
// (key "trend_views", same precedent as trend_pins). The list math (add/rename/
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
