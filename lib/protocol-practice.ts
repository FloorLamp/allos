// Pure parse/validate for a protocol's optional PRACTICE (issue #344): "track
// adherence to <activity type> × N per week". The protocol form submits a type and
// a per-week count; adherence itself reuses the frequency-target weekly-count
// computation (one question, one computation), so this only owns turning raw form
// input into a valid (type, perWeek) pair or "no practice". No DB/network;
// unit-tested in lib/__tests__/protocol-practice.test.ts.

import { TYPE_SCOPES } from "./lifts";

// The activity types a practice can target — the same coarse type set
// frequency_targets already supports for scope_kind='type' (strength/cardio/sport).
// A recovery session (sauna, plunge) is logged as a custom-named cardio/sport
// activity, so it counts under its type.
export const PRACTICE_TYPES = TYPE_SCOPES;
export type PracticeType = (typeof PRACTICE_TYPES)[number];

// The largest sane weekly frequency; keeps a fat-fingered "70" from creating a
// permanently-behind target. Twice-a-day every day is already 14.
const MAX_PER_WEEK = 14;

export interface ParsedPractice {
  // Present only when BOTH a valid type and a positive per-week were given.
  practiceType: PracticeType;
  perWeek: number;
}

// Parse the raw form values into a valid practice, or null (no practice tracked).
// A blank/unknown type, or a non-positive/NaN per-week, yields null — the practice
// is optional, so incomplete input simply means "don't track adherence". A valid
// per-week is floored and clamped to [1, MAX_PER_WEEK].
export function parseProtocolPractice(
  rawType: string | null | undefined,
  rawPerWeek: string | number | null | undefined
): ParsedPractice | null {
  const type = (rawType ?? "").trim();
  if (!PRACTICE_TYPES.includes(type as PracticeType)) return null;
  const n =
    typeof rawPerWeek === "number" ? rawPerWeek : Number(rawPerWeek ?? "");
  if (!Number.isFinite(n) || n < 1) return null;
  const perWeek = Math.min(MAX_PER_WEEK, Math.floor(n));
  return { practiceType: type as PracticeType, perWeek };
}
