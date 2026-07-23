// The ONE pure UV-dose computation (issue #1172). It crosses the daylight-outdoor
// windows (WHEN you were outside — the #571 daylight intersection) with the UV that
// actually occurred during those hours (the cached Open-Meteo series, historical for
// past days) → a two-sided UV dose: enough for vitamin-D synthesis + circadian light,
// but not so much you burn. "One question, one computation" (#221) — every surface
// (the sun-exposure protocol, the outdoor-time chart, the DaylightChip, the
// overexposure care finding) formats THIS result, so a second engine can never drift.
//
// Pure (no DB/clock/network): it takes already-loaded outdoor windows + an effective
// hourly-UV map + skin type, and returns the dose. The DB assembly (home location,
// timezone, outdoor activities, cache read, degradation ladder) lives in
// lib/queries/weather; the offline solar geometry stays in lib/sun.
//
// PHYSICS. The UV Index is a dimensionless number; the erythemally-weighted
// irradiance is E_er (W/m²) = UVI × 0.025. Erythemal dose over t seconds is
// UVI × 0.025 × t (J/m²); 1 SED (standard erythema dose) = 100 J/m². So, per minute:
//   SED = UVI × minutes × 0.015
// and vice-versa the minutes to reach a dose D (SED) at a steady UVI is
//   minutes = D / (UVI × 0.015).
// These are the standard WHO/erythemal-action-spectrum conversions.

// Fitzpatrick skin phototype I–VI (the overexposure sub-dependency, #1172). Stored
// per profile; null when unset (the overexposure side then stays SILENT rather than
// guessing — degrade gracefully). Typed 1..6 so the numeric MED table is total.
export type FitzpatrickType = 1 | 2 | 3 | 4 | 5 | 6;

// SED accumulated per (UVI × minute) — the physics constant above.
export const SED_PER_UV_MINUTE = 0.015;

// "Meaningful UV" for vitamin-D synthesis: UVB is only appreciable at roughly
// UV Index ≥ 3 (the WHO "moderate" threshold). Time outdoors below this counts for
// circadian light but not the vitamin-D sufficiency side.
export const MEANINGFUL_UV_INDEX = 3;

// The vitamin-D/circadian SUFFICIENCY threshold (coaching tier). Erythemal SED
// accumulated during meaningful-UV hours; ~0.5 SED is a conservative "you got real
// UVB" mark (a fraction of even a fair-skinned MED — never a burn). Deliberately
// modest: the sufficiency side is calm/observational, not a prescription.
export const VITAMIN_D_SUFFICIENT_SED = 0.5;

// Minimal erythemal dose by Fitzpatrick type, in SED (1 SED = 100 J/m²). Standard
// clinical approximations (type I ≈ 200 J/m², rising to type VI ≈ 1000 J/m²); the
// cumulative erythemal dose reaching this is where a burn begins for that skin type.
export const SKIN_TYPE_MED_SED: Record<FitzpatrickType, number> = {
  1: 2.0,
  2: 2.5,
  3: 3.0,
  4: 4.5,
  5: 6.0,
  6: 10.0,
};

// Parse a stored/user skin-type value into a FitzpatrickType, or null (unset/invalid
// → overexposure side stays silent). Accepts "1".."6" or 1..6.
export function parseSkinType(
  v: string | number | null | undefined
): FitzpatrickType | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 6) return null;
  return n as FitzpatrickType;
}

// A coarse CLEAR-SKY UV-Index ceiling from the sun's elevation (degrees). The offline
// fallback rung of the degradation ladder (#570 guarantee): when no live UV and no
// provider clear-sky field is available, sun.ts geometry still bounds the UV. This is
// a deliberately rough, elevation-driven ceiling — clear-sky UVI peaks near ~12 at the
// zenith and falls off with elevation — NOT a measurement; it never drives the
// overexposure warning past a real threshold on its own beyond what the geometry allows.
export function elevationUvCeiling(elevationDeg: number): number {
  if (elevationDeg <= 0) return 0;
  const s = Math.sin((elevationDeg * Math.PI) / 180);
  return 12 * Math.pow(s, 1.5);
}

// How the effective hourly UV was resolved — the degradation ladder provenance.
// "live" = actual UV from the provider; "clear-sky" = the estimate rung (provider
// uv_index_clear_sky or the sun.ts elevation ceiling); "none" = no UV available at
// all, so the result degrades to minutes-only (dose fields null).
export type UvSource = "live" | "clear-sky" | "none";

export interface UvDoseInput {
  // Daylight-clipped OUTDOOR windows, local minutes past midnight (already the #571
  // intersection of the activity window with the daylight window). Empty → no dose.
  windows: { startMin: number; endMin: number }[];
  // Effective UV Index by LOCAL hour (0..23), already resolved to live or clear-sky.
  // A missing hour contributes 0 UV (but its minutes still count as outdoor time).
  hourlyUv: Map<number, number>;
  // Provenance of hourlyUv for the degradation ladder. "none" forces a minutes-only
  // result (all dose fields null) regardless of hourlyUv.
  uvSource: UvSource;
  // Fitzpatrick skin type for the burn threshold, or null (overexposure side silent).
  skinType: FitzpatrickType | null;
}

export interface UvDoseResult {
  uvSource: UvSource;
  // Total outdoor daylight minutes (the #571 minutes-only figure, always defined).
  outdoorMinutes: number;
  // UV-minutes: Σ (minutes in hour × UV in hour). null when uvSource === "none".
  uvMinutes: number | null;
  // Erythemal dose over the whole outdoor time (SED). null when uvSource === "none".
  sed: number | null;
  // Minutes spent outdoors during meaningful-UV (≥ MEANINGFUL_UV_INDEX) hours.
  meaningfulUvMinutes: number | null;
  // Erythemal SED accumulated during meaningful-UV hours (the vitamin-D side).
  vitaminDSed: number | null;
  // Vitamin-D/circadian sufficiency (coaching): vitaminDSed ≥ VITAMIN_D_SUFFICIENT_SED.
  // null when uvSource === "none".
  sufficient: boolean | null;
  // Peak UV Index over the outdoor windows. null when uvSource === "none".
  peakUvIndex: number | null;
  // Minutes to a burn at the peak UV for this skin type. null without skin type or UV.
  minutesToBurn: number | null;
  // Cumulative dose past the skin-type MED. null without skin type or UV.
  overexposed: boolean | null;
}

// Minutes of overlap of [aStart,aEnd] with [bStart,bEnd], clamped at 0.
function overlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// The one computation. Crosses the outdoor windows with the hourly UV → the two-sided
// dose. Pure and deterministic.
export function computeUvDose(input: UvDoseInput): UvDoseResult {
  let outdoorMinutes = 0;
  for (const w of input.windows) {
    outdoorMinutes += Math.max(0, w.endMin - w.startMin);
  }
  outdoorMinutes = Math.round(outdoorMinutes);

  // No UV signal at all → degrade to minutes-only; every dose field is null.
  if (input.uvSource === "none") {
    return {
      uvSource: "none",
      outdoorMinutes,
      uvMinutes: null,
      sed: null,
      meaningfulUvMinutes: null,
      vitaminDSed: null,
      sufficient: null,
      peakUvIndex: null,
      minutesToBurn: null,
      overexposed: null,
    };
  }

  let uvMinutes = 0;
  let sed = 0;
  let meaningfulUvMinutes = 0;
  let vitaminDSed = 0;
  let peakUvIndex = 0;

  for (const w of input.windows) {
    const start = w.startMin;
    const end = w.endMin;
    if (end <= start) continue;
    const firstHour = Math.floor(start / 60);
    const lastHour = Math.floor((end - 1) / 60);
    for (let h = firstHour; h <= lastHour; h++) {
      const mins = overlap(start, end, h * 60, (h + 1) * 60);
      if (mins <= 0) continue;
      const uv = input.hourlyUv.get(h) ?? 0;
      uvMinutes += mins * uv;
      const dose = mins * uv * SED_PER_UV_MINUTE;
      sed += dose;
      if (uv > peakUvIndex) peakUvIndex = uv;
      if (uv >= MEANINGFUL_UV_INDEX) {
        meaningfulUvMinutes += mins;
        vitaminDSed += dose;
      }
    }
  }

  const skinType = input.skinType;
  let minutesToBurn: number | null = null;
  let overexposed: boolean | null = null;
  if (skinType != null) {
    const med = SKIN_TYPE_MED_SED[skinType];
    overexposed = sed >= med;
    // Minutes to burn at the peak UV encountered (steady-peak worst case).
    if (peakUvIndex > 0) {
      minutesToBurn = med / (peakUvIndex * SED_PER_UV_MINUTE);
    }
  }

  return {
    uvSource: input.uvSource,
    outdoorMinutes,
    uvMinutes: Math.round(uvMinutes),
    sed,
    meaningfulUvMinutes: Math.round(meaningfulUvMinutes),
    vitaminDSed,
    sufficient: vitaminDSed >= VITAMIN_D_SUFFICIENT_SED,
    peakUvIndex,
    minutesToBurn: minutesToBurn == null ? null : Math.round(minutesToBurn),
    overexposed,
  };
}
