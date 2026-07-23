// Pure parse/validate for a protocol's optional PRACTICE (issue #344): "track
// adherence to <activity type> × N per week". The protocol form submits a type and
// a per-week count; adherence itself reuses the frequency-target weekly-count
// computation (one question, one computation), so this only owns turning raw form
// input into a valid (type, perWeek) pair or "no practice". No DB/network;
// unit-tested in lib/__tests__/protocol-practice.test.ts.

import { TYPE_SCOPES } from "./lifts";
import { isValidFoodGroup, foodGroupName } from "./food-groups";
import { normalizePracticeName } from "./practice";

// The activity-type display labels for a practice's scope value.
const PRACTICE_TYPE_LABELS: Record<string, string> = {
  strength: "Strength",
  cardio: "Cardio",
  sport: "Sport",
};

// The human "<label>" noun for a practice's scope — activity-type SESSIONS or
// food-group SERVINGS (e.g. "Strength sessions", "Fatty fish servings"). Shared by
// the protocol detail card and the active-protocol dashboard widget (issue #660) so
// the two adherence surfaces read the same phrase (one question, one computation).
export function protocolPracticeLabel(
  scopeKind: "type" | "food_group" | "practice",
  value: string
): string {
  if (scopeKind === "food_group") return `${foodGroupName(value)} servings`;
  // A wellness practice (#1259) reads by its own NAME ("Red light therapy sessions",
  // "Sauna sessions") — no type-label lookup, the name IS the label.
  if (scopeKind === "practice") return `${value} sessions`;
  return `${PRACTICE_TYPE_LABELS[value] ?? value} sessions`;
}

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

// A protocol practice generalized over its scope (#580, #1259): an activity type, a food
// group, OR a wellness practice — the frequency_target scopes a protocol can adopt as its
// intervention. `perWeekMax` (#1259) is the optional weekly ceiling (a range), set only
// for a practice today.
export interface ScopedPractice {
  scopeKind: "type" | "food_group" | "practice";
  scopeValue: string;
  perWeek: number;
  perWeekMax: number | null;
}

// The `<select>` value prefixes so ONE select can list activity types (bare values),
// food groups (`food_group:<slug>`), and wellness practices (`practice:<name>`) without a
// second form field. The `practice:` prefix here carries a practice NAME — a DIFFERENT
// namespace from lib/practice.ts's `practice:<targetId>` signal key (they never meet).
const FOOD_PRACTICE_PREFIX = "food_group:";
const WELLNESS_PRACTICE_PREFIX = "practice:";
// The select sentinel for "a custom (free-text) wellness practice" — the name then comes
// from the sibling `practice_custom` text field.
export const CUSTOM_PRACTICE_VALUE = "practice:__custom__";

export function practiceSelectValue(
  scopeKind: "type" | "food_group" | "practice",
  value: string
): string {
  if (scopeKind === "food_group") return `${FOOD_PRACTICE_PREFIX}${value}`;
  if (scopeKind === "practice") return `${WELLNESS_PRACTICE_PREFIX}${value}`;
  return value;
}

// Parse the combined practice select value into a scoped practice, or null. A value
// prefixed `food_group:` resolves to a food-group scope (validated against the curated
// catalog); `practice:<name>` resolves to a wellness-practice scope (the custom sentinel
// falls back to `rawCustom`); a bare value resolves to an activity-type scope; anything
// else — or a non-positive per-week — is "no practice". Per-week clamped to
// [1, MAX_PER_WEEK]; the optional ceiling must be > floor and ≤ MAX_PER_WEEK else NULL,
// and is honored ONLY for a wellness practice (the range is a practice concept).
export function parseScopedPractice(
  rawValue: string | null | undefined,
  rawPerWeek: string | number | null | undefined,
  rawPerWeekMax?: string | number | null,
  rawCustom?: string | null
): ScopedPractice | null {
  const value = (rawValue ?? "").trim();
  const n =
    typeof rawPerWeek === "number" ? rawPerWeek : Number(rawPerWeek ?? "");
  if (!value || !Number.isFinite(n) || n < 1) return null;
  const perWeek = Math.min(MAX_PER_WEEK, Math.floor(n));

  const parseMax = (): number | null => {
    const m =
      typeof rawPerWeekMax === "number"
        ? rawPerWeekMax
        : Number(rawPerWeekMax ?? "");
    if (!Number.isFinite(m)) return null;
    const max = Math.min(MAX_PER_WEEK, Math.floor(m));
    return max > perWeek ? max : null;
  };

  if (value.startsWith(FOOD_PRACTICE_PREFIX)) {
    const slug = value.slice(FOOD_PRACTICE_PREFIX.length);
    if (!isValidFoodGroup(slug)) return null;
    return {
      scopeKind: "food_group",
      scopeValue: slug,
      perWeek,
      perWeekMax: null,
    };
  }
  if (
    value === CUSTOM_PRACTICE_VALUE ||
    value.startsWith(WELLNESS_PRACTICE_PREFIX)
  ) {
    const name =
      value === CUSTOM_PRACTICE_VALUE
        ? normalizePracticeName(rawCustom)
        : normalizePracticeName(value.slice(WELLNESS_PRACTICE_PREFIX.length));
    if (!name) return null;
    return {
      scopeKind: "practice",
      scopeValue: name,
      perWeek,
      perWeekMax: parseMax(),
    };
  }
  if (PRACTICE_TYPES.includes(value as PracticeType))
    return { scopeKind: "type", scopeValue: value, perWeek, perWeekMax: null };
  return null;
}
