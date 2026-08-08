import type { DistanceUnit, TemperatureUnit, WeightUnit } from "./settings";

// Canonical storage units are kilograms and kilometers.
export const LB_PER_KG = 2.2046226218;
export const MI_PER_KM = 0.62137119224;

// ---- THE CANONICAL-UNIT BRANDS (#2149 item 2) -----------------------------
//
// "Canonical storage uses kilograms and kilometers; convert only at the boundaries"
// used to be enforced by review alone — a surface that handed a display-unit number
// (the user's POUNDS) straight to a storage writer compiled fine and silently stored
// a number 2.2× too large. `Kg` and `Km` make that unwritable: a storage writer that
// demands the brand cannot be fed a raw `number` at all, so the conversion is no
// longer something a reviewer has to notice.
//
// COMPILE-TIME ONLY. A brand is `number` intersected with a phantom property that
// exists only in the type system, so a `Kg` IS a number everywhere at runtime — it
// arithmetics, formats, and binds to SQL exactly as before, and the brands erase to
// nothing in the emitted JavaScript. Nothing about the stored values changes.
//
// `toKg` / `toKm` ARE THE ONLY MINTERS. They hold the only two casts that MAY produce
// a branded value; writing `x as Kg` anywhere else forges the guarantee and defeats
// the guard entirely, and review is the backstop for that exactly as it is for
// `as any`. Three ways a canonical number legitimately arises, all of them a call:
//
//   • a display-unit number converted at a write boundary — `toKg(entered, unit)`,
//     the ordinary case;
//   • a number that is ALREADY canonical (a value read back out of the database, a
//     provider payload the API documents in kg) — `toKg(stored, "kg")`, which is the
//     identity conversion and therefore free at runtime, and which reads as the
//     declaration it is: "this number is in kilograms";
//   • a number derived by ARITHMETIC from canonical ones (summing a session's legs).
//     Arithmetic on branded numbers yields a plain `number` — TypeScript cannot know
//     that kg + kg is kg but kg × kg is not — so a derived canonical value re-mints
//     through the same identity call at the point it is declared canonical again.
//
// Reads are deliberately NOT branded: a value coming OUT of storage is already
// canonical by construction, and branding the read side would mean touching every
// chart, formatter, and aggregate for no additional safety. The brands guard the
// direction where the mistake is silent and permanent — the write.
declare const CANONICAL_UNIT: unique symbol;

/** A mass in canonical KILOGRAMS. Minted only by `toKg`. */
export type Kg = number & { readonly [CANONICAL_UNIT]: "kg" };
/** A distance in canonical KILOMETERS. Minted only by `toKm`. */
export type Km = number & { readonly [CANONICAL_UNIT]: "km" };

export function kgTo(kg: number, unit: WeightUnit): number {
  return unit === "lb" ? kg * LB_PER_KG : kg;
}
/** Mint canonical kilograms from a value stated in `unit`. THE weight minter. */
export function toKg(value: number, unit: WeightUnit): Kg {
  return (unit === "lb" ? value / LB_PER_KG : value) as Kg;
}
export function kmTo(km: number, unit: DistanceUnit): number {
  return unit === "mi" ? km * MI_PER_KM : km;
}
/** Mint canonical kilometers from a value stated in `unit`. THE distance minter. */
export function toKm(value: number, unit: DistanceUnit): Km {
  return (unit === "mi" ? value / MI_PER_KM : value) as Km;
}

export function round(n: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Resolve the unit a submitted display-value was CAPTURED in, honoring a unit
// carried alongside the value over the login's current stored preference (issue
// #630). A weight/distance form renders the number in the login's unit at render
// time, but the write can fire long after (the docked journal editor auto-saves
// on a debounce) — if the login flips its preference in another tab meanwhile, a
// write that re-reads the pref would mis-convert a correctly-entered number. So
// the form posts the render-time unit and the action trusts it, falling back to
// the stored pref only when the field is absent/garbage (older clients, other
// callers). This is the general form of #467's compare-and-set: carry the
// interpretation with the value whenever the interpretation depends on a mutable
// pref.
export function submittedWeightUnit(
  raw: unknown,
  fallback: WeightUnit
): WeightUnit {
  return raw === "kg" || raw === "lb" ? raw : fallback;
}
export function submittedDistanceUnit(
  raw: unknown,
  fallback: DistanceUnit
): DistanceUnit {
  return raw === "km" || raw === "mi" ? raw : fallback;
}

// Resolve a submitted display-unit weight back to canonical kg, treating a
// value that is materially unchanged from the stored canonical value as a true
// no-op. Edit forms pre-fill `round(kgTo(stored, unit), decimals)`; on save the
// action would re-store `toKg(submitted, unit)`, which for lb-preference users
// nudges the canonical kg by up to the rounding quantum on every round-trip —
// even when the user never touched the field. So if the submitted (display)
// number equals the rounded display of the stored kg, keep the stored kg
// exactly rather than re-deriving it from the rounded display (issue #194). A
// genuinely changed value still converts through toKg as before.
//
// Returns `Kg` either way: the stored branch re-mints the value it read back out of
// the database through the identity conversion (see the brand note above), which is
// a no-op at runtime and keeps the write boundary's output branded.
export function resolveWeightKg(
  submitted: number,
  storedKg: number | null | undefined,
  unit: WeightUnit,
  decimals = 1
): Kg {
  if (
    storedKg != null &&
    round(kgTo(storedKg, unit), decimals) === round(submitted, decimals)
  ) {
    return toKg(storedKg, "kg");
  }
  return toKg(submitted, unit);
}

// Sanitize a numeric text input so it can't hold a negative value: strips any
// minus signs while leaving an in-progress decimal ("1.", "0.5") untouched.
// Weights are never negative, so this enforces a floor of 0 on entry.
export function stripNegative(v: string): string {
  return v.replace(/-/g, "");
}

// Sanitize an integer count input (reps) where zero is as meaningless as a
// negative: a value that parses to 0 clears to empty, enforcing a floor of 1
// on anything actually entered.
export function stripNonPositive(v: string): string {
  const s = stripNegative(v);
  return s.trim() !== "" && Number(s) === 0 ? "" : s;
}

// Display number (converted + rounded), e.g. for chart values.
export function dispWeight(kg: number, unit: WeightUnit, decimals = 1): number {
  return round(kgTo(kg, unit), decimals);
}

// Formatted strings with the unit suffix.
export function fmtWeight(
  kg: number | null | undefined,
  unit: WeightUnit
): string {
  if (kg == null) return "—";
  return `${round(kgTo(kg, unit), 1)} ${unit}`;
}
export function fmtDistance(
  km: number | null | undefined,
  unit: DistanceUnit
): string {
  if (km == null) return "—";
  return `${round(kmTo(km, unit), 2)} ${unit}`;
}

// ---- Body temperature (canonical storage is always °F) ----
// A reading is stored in the canonical Fahrenheit scale (lib/vitals-input.ts); the
// login's `temperatureUnit` preference only chooses how it's DISPLAYED. This is the
// single display-conversion boundary (the `kgTo`/`kmTo` precedent) so no surface
// forks the °F→°C math. The write boundary is `toCanonicalTempF` in lib/vitals-input.

// Canonical °F → the display unit, rounded to 0.1° (temperatures are read to a tenth).
export function degFTo(degF: number, unit: TemperatureUnit): number {
  return unit === "C" ? round((degF - 32) * (5 / 9), 1) : round(degF, 1);
}

// The degree suffix for a display unit ("°F" / "°C").
export function tempUnitLabel(unit: TemperatureUnit): string {
  return unit === "C" ? "°C" : "°F";
}

// A canonical (°F) temperature formatted in the login's preferred unit, e.g.
// "101.3 °F" or "38.5 °C". The ONE formatter every temperature display reads through
// so a °C login sees °C everywhere and the conversion can't drift (issue #857).
export function fmtTemp(
  degF: number | null | undefined,
  unit: TemperatureUnit
): string {
  if (degF == null) return "—";
  return `${degFTo(degF, unit)} ${tempUnitLabel(unit)}`;
}

// A canonical (°F) temperature rendered in BOTH scales — "38.5 °C / 101.3 °F".
// The notification form for safety-critical temperature (#1019): a Telegram
// nudge has no login-unit context (prefs are per-login, notifications
// per-profile), and a mixed-preference household must read a fever red-flag
// correctly either way, so the safety message errs toward redundancy. Every
// other notification measurement stays canonical (see docs/internals/findings.md).
export function fmtTempDual(degF: number | null | undefined): string {
  if (degF == null) return "—";
  return `${fmtTemp(degF, "C")} / ${fmtTemp(degF, "F")}`;
}

// A speed given in km/h, rendered in the user's distance unit ("12.4 km/h").
export function fmtKmh(
  kmh: number | null | undefined,
  unit: DistanceUnit
): string {
  if (kmh == null) return "—";
  return `${round(kmTo(kmh, unit), 1)} ${unit}/h`;
}

// Average speed in the user's distance unit per hour, or null if not derivable.
export function avgSpeed(
  km: number | null | undefined,
  durationMin: number | null | undefined,
  unit: DistanceUnit
): number | null {
  if (km == null || !durationMin || durationMin <= 0) return null;
  return round(kmTo(km, unit) / (durationMin / 60), 1);
}

export function fmtSpeed(
  km: number | null | undefined,
  durationMin: number | null | undefined,
  unit: DistanceUnit
): string | null {
  const s = avgSpeed(km, durationMin, unit);
  return s == null ? null : `${s} ${unit}/h`;
}
