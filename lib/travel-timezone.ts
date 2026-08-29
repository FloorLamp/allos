// Travel (issue #3263) — what a timezone SWITCH does to a profile's local day.
//
// #2205 made every instant absolute and every day profile-local, so moving a
// profile's zone already moves `today()`, the day windows, the streaks and the
// notification slots. What it does NOT settle is the SWITCH DAY itself, and that
// day is where clock arithmetic can quietly lie to somebody about their own
// adherence:
//
//   • WESTWARD (the local clock jumps BACK) a stretch of wall clock happens a
//     SECOND time. The morning dose taken at 08:00 in Tokyo must not be asked for
//     again when 08:00 comes round in Honolulu, and must not be counted twice.
//   • EASTWARD (the local clock jumps FORWARD) a stretch of wall clock never
//     happens at all. The 20:00 dose the traveller flew over was not MISSED — it
//     was IMPOSSIBLE — and the difference is invisible to arithmetic that only
//     knows "the hour passed and nothing was logged".
//
// So this module answers one question about one profile-local wall-clock position:
// did it happen, did it happen twice, or did it never happen? Everything the
// feature does downstream — the excused denominator, the silent reminder, the
// assertion that a repeat is not a re-ask — is that question with a different
// consumer.
//
// PURE. Intl only: no DB, no clock, no settings. `lib/settings/travel.ts` is the
// storage side and `lib/travel-excusal.ts` is the profile-scoped resolver over it.

import { dateStrInTz, minuteOfDayInTz } from "./date";
import { isValidTimezone } from "./timezone";

// A position on a profile's own wall clock: which local calendar day, and which
// minute of it. NOT an instant — the whole point of the switch day is that one
// position can map to two instants (westward) or to none (eastward).
export interface LocalPosition {
  day: string; // YYYY-MM-DD, profile-local
  minute: number; // 0–1439, profile-local minute of day
}

// The profile-local position an instant lands on in a given zone.
export function localPositionIn(tz: string, at: Date): LocalPosition {
  return { day: dateStrInTz(tz, at), minute: minuteOfDayInTz(tz, at) };
}

// Chronological order over local positions. Negative when `a` is earlier on the
// local calendar than `b`. Day strings are ISO, so they compare lexically.
export function comparePositions(a: LocalPosition, b: LocalPosition): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return a.minute - b.minute;
}

// One recorded move of a profile's timezone. `at` is the canonical UTC instant the
// switch took effect; `from`/`to` are IANA zones. Written by every path that moves
// the zone for TRAVEL (the accepted outbound and return offers), so the rules
// below can be asked about a day after the fact.
export interface TimezoneSwitch {
  at: string;
  from: string;
  to: string;
}

// Which way a switch moved the wall clock, in the profile's own terms.
//
//   "forward"  — eastward: local time jumped ahead, a span of wall clock VANISHED.
//   "backward" — westward: local time jumped back, a span of wall clock REPEATS.
//   "level"    — the two zones read the same wall clock at that instant (a move
//                between zones on the same offset, or a no-op). Nothing to rule on.
export type SwitchDirection = "forward" | "backward" | "level";

// A switch resolved into the two local positions it joined. `left` is where the
// clock was under the OLD zone at the switch instant; `landed` is where it read
// under the NEW zone at the same instant. Both are real moments — the switch is
// instantaneous, so the profile genuinely occupied both.
export interface ResolvedSwitch {
  direction: SwitchDirection;
  left: LocalPosition;
  landed: LocalPosition;
}

// Resolve a stored switch, or null when it is unusable (an unparseable instant, a
// zone that is not a real IANA name). Null rather than a throw: these records are
// read on every adherence render and on every notify tick, and one corrupt row must
// never be able to take a page or a send down.
export function resolveSwitch(sw: TimezoneSwitch): ResolvedSwitch | null {
  const at = new Date(sw.at);
  if (Number.isNaN(at.getTime())) return null;
  if (!isValidTimezone(sw.from) || !isValidTimezone(sw.to)) return null;
  const left = localPositionIn(sw.from, at);
  const landed = localPositionIn(sw.to, at);
  const cmp = comparePositions(left, landed);
  return {
    direction: cmp === 0 ? "level" : cmp < 0 ? "forward" : "backward",
    left,
    landed,
  };
}

// Did this local position NEVER OCCUR for the profile, because a switch jumped the
// clock over it?
//
// OPEN AT BOTH ENDS, and that is the load-bearing part. `left` is the wall clock the
// profile was actually reading at the moment it switched, and `landed` is the one it
// read immediately after — both are moments that happened. Only what lies strictly
// between them was skipped. Closing either end would excuse a slot whose minute the
// profile really did live through, which is the same class of lie in the opposite
// direction: a dose silently dropped from the denominator that the person could have
// taken and we never asked about.
export function neverOccurred(sw: TimezoneSwitch, p: LocalPosition): boolean {
  const r = resolveSwitch(sw);
  if (!r || r.direction !== "forward") return false;
  return comparePositions(r.left, p) < 0 && comparePositions(p, r.landed) < 0;
}

// Did this local position OCCUR TWICE, because a switch put the clock back?
//
// CLOSED AT BOTH ENDS, for the mirror-image reason. After a westward switch the
// clock stands at `landed` for the second time and will run forward through `left`
// again, so both endpoints are lived through twice. Nothing here changes behaviour
// on its own — a repeat is already harmless, because a dose log is keyed by dose +
// profile-local DATE and a reminder slot's per-day marker is keyed by that same date.
// This predicate is what lets that claim be ASSERTED rather than assumed.
export function occurredTwice(sw: TimezoneSwitch, p: LocalPosition): boolean {
  const r = resolveSwitch(sw);
  if (!r || r.direction !== "backward") return false;
  return comparePositions(r.landed, p) <= 0 && comparePositions(p, r.left) <= 0;
}

// Accept a history only when every retained switch forms one valid, chronological
// chain that actually leads to `currentZone`. The history is a bounded JSON setting
// rather than an event ledger, so an old client, a manual Settings edit, or a corrupt
// duplicate can leave a discontinuity. A valid-looking suffix is NOT enough: the
// missing seam at its boundary could cancel a crossing in that suffix. Failing open
// means rejecting the whole retained history so uncertainty never silently excuses
// a real dose or suppresses its reminder.
//
// When no current zone is supplied, the newest record's destination anchors the
// chain. This keeps the pure predicates safe for callers that only have history;
// profile-scoped consumers pass the stored current zone as the stronger anchor.
export function connectedTimezoneSwitchHistory(
  switches: readonly TimezoneSwitch[],
  currentZone?: string
): TimezoneSwitch[] {
  if (switches.length === 0) return [];

  let expectedDestination = currentZone ?? switches.at(-1)?.to;
  let nextInstant = Number.POSITIVE_INFINITY;
  const connected: TimezoneSwitch[] = [];

  for (let i = switches.length - 1; i >= 0; i -= 1) {
    const sw = switches[i];
    const instant = Date.parse(sw.at);
    if (
      !expectedDestination ||
      !Number.isFinite(instant) ||
      !isValidTimezone(sw.from) ||
      !isValidTimezone(sw.to) ||
      sw.to !== expectedDestination ||
      instant >= nextInstant
    ) {
      return [];
    }
    connected.unshift(sw);
    expectedDestination = sw.from;
    nextInstant = instant;
  }

  return connected;
}

// How many times this position occurred after the ordered switch history adjusts
// the ordinary once-per-day wall clock. A forward crossing removes an occurrence;
// a backward crossing adds one. Counting the whole trajectory matters: a quick
// eastward switch can skip noon and a later westward switch can put noon back into
// the same day. Treating the forward spans as a union would still call that real
// noon impossible.
function positionOccurrences(
  switches: readonly TimezoneSwitch[],
  p: LocalPosition
): number {
  let occurrences = 1;
  for (const sw of connectedTimezoneSwitchHistory(switches)) {
    if (neverOccurred(sw, p)) occurrences -= 1;
    else if (occurredTwice(sw, p)) occurrences += 1;
  }
  return occurrences;
}

// EXCUSED: this profile-local slot did not occur after the complete switch
// trajectory is accounted for. The word matters — "excused" is not "missed" and
// not "skipped" and not "not due". It is a slot the calendar demanded and the
// planet refused, and it is out of the day's adherence denominator for exactly
// that reason.
export function isExcusedSlot(
  switches: readonly TimezoneSwitch[],
  day: string,
  minute: number
): boolean {
  const p = { day, minute };
  return positionOccurrences(switches, p) <= 0;
}

// The mirror predicate, for the westward pins: after the complete trajectory this
// slot's wall clock came round more than once on this local day.
export function isRepeatedSlot(
  switches: readonly TimezoneSwitch[],
  day: string,
  minute: number
): boolean {
  const p = { day, minute };
  return positionOccurrences(switches, p) > 1;
}

// ---- The zone a past instant was lived in (#4025) --------------------------

// A profile's day zone as the DATED readers take it: a plain IANA name when the
// profile's zone has never moved — the overwhelming case, and byte-identical to the
// pre-#4025 behaviour — or a resolver over its recorded switch history when it has.
export type ProfileDayZone = string | ((at: Date) => string);

export function zoneOf(zone: ProfileDayZone, at: Date): string {
  return typeof zone === "string" ? zone : zone(at);
}

// Which zone this profile's day was running on at `at`.
//
// Turning a stored UTC stamp into a profile-local DAY is the whole subject of this
// module, and the answer depends on where the profile's day was running THEN, not on
// where it is standing now. Resolve a historical stamp through the CURRENT zone and an
// eastward move walks its day forward — far enough, for a stamp sitting within the
// offset delta of local midnight, to walk a dose's lifetime bound past a day the dose
// demonstrably existed on, which drops it from a rebuilt reminder and from what
// `✅ All` writes (#4025).
//
// The recorded switch history is the evidence, read through the SAME fail-open gate
// every other consumer uses: an unusable or absent history yields the current zone,
// which is exactly the pre-#4025 answer. A zone move that was never recorded — an
// ordinary Settings correction outside a trip — leaves no evidence at all, so no
// read-time rule can see it.
export function zoneAtInstant(
  switches: readonly TimezoneSwitch[],
  currentZone: string,
  at: Date
): string {
  return zoneInChainAt(
    connectedTimezoneSwitchHistory(switches, currentZone),
    currentZone,
    at
  );
}

// The walk itself, over a history ALREADY through the gate above — for a caller that
// resolves many instants against one profile's history and should not re-validate it
// per instant. `connectedTimezoneSwitchHistory` calls `isValidTimezone` twice per
// switch, and that constructs an Intl.DateTimeFormat uncached: at a full 24-switch
// history, one strip's 60 creation stamps cost 2880 constructions when the chain is
// rebuilt per stamp and 48 when it is built once (#4030). Same walk either way —
// `zoneAtInstant` is this function plus the gate, so there is still one computation.
export function zoneInChainAt(
  chain: readonly TimezoneSwitch[],
  currentZone: string,
  at: Date
): string {
  const t = at.getTime();
  // The chain is chronological and ends at `currentZone`, so the FIRST switch that
  // happened after `at` is the one this instant preceded: the zone in force then is
  // the one that switch moved away from.
  for (const sw of chain) {
    if (Date.parse(sw.at) > t) return sw.from;
  }
  return currentZone;
}

// ---- Stored switch history ----

// How many switches are kept per profile. A trip is a handful of switches; the
// history exists only so a day already rendered can still be explained, so it is
// bounded rather than an unbounded log. Oldest are dropped first.
export const MAX_STORED_SWITCHES = 24;

// How far back a stored switch stays useful: the longest window any adherence
// surface scores (the month calendar and the 90-day dose history), with room over.
// Beyond it the switch day is off every strip and the record is dead weight.
export const SWITCH_RETENTION_DAYS = 120;

export interface DecodedTimezoneSwitchHistory {
  switches: TimezoneSwitch[];
  valid: boolean;
}

// Decode the stored JSON array without throwing while preserving whether it was
// trustworthy. Writers need the validity bit: treating malformed history as an
// ordinary empty history and appending one new seam would launder the corruption
// into a trusted one-way crossing.
export function decodeTimezoneSwitchHistory(
  raw: string | null | undefined
): DecodedTimezoneSwitchHistory {
  if (raw == null) return { switches: [], valid: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { switches: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { switches: [], valid: false };
  const out: TimezoneSwitch[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object")
      return { switches: [], valid: false };
    const { at, from, to } = entry as Record<string, unknown>;
    if (typeof at !== "string") return { switches: [], valid: false };
    if (typeof from !== "string" || typeof to !== "string")
      return { switches: [], valid: false };
    out.push({ at, from, to });
  }
  return { switches: out, valid: true };
}

// Reader convenience. Invalid storage is the ordinary fail-open empty history;
// switch writers use decodeTimezoneSwitchHistory so they do not erase its taint.
export function parseTimezoneSwitches(
  raw: string | null | undefined
): TimezoneSwitch[] {
  return decodeTimezoneSwitchHistory(raw).switches;
}

export function serializeTimezoneSwitches(
  switches: readonly TimezoneSwitch[]
): string {
  return JSON.stringify(switches);
}

// Append a switch to a profile's history, dropping records that have aged past
// SWITCH_RETENTION_DAYS and then trimming to MAX_STORED_SWITCHES newest-last. Pure,
// so the pruning rule is pinned without a database.
export function appendTimezoneSwitch(
  history: readonly TimezoneSwitch[],
  next: TimezoneSwitch,
  now: Date
): TimezoneSwitch[] {
  const floor = now.getTime() - SWITCH_RETENTION_DAYS * 86_400_000;
  const kept = history.filter((sw) => {
    const t = new Date(sw.at).getTime();
    return Number.isFinite(t) && t >= floor;
  });
  kept.push(next);
  return kept.slice(-MAX_STORED_SWITCHES);
}

// ---- The banner (shown, never sent — #3084) ----

// What the shell should put in front of the person, if anything.
//
//   "offer"  — the device is somewhere the profile is not; ASK before moving the
//              day, because a layover or a VPN must not move it (#2471).
//   "return" — the device reports the zone the profile left. This is still an
//              OFFER: a home-terminating VPN can produce the same browser signal,
//              so returning asks exactly as travelling out does (#3684).
export type TravelPrompt =
  | { kind: "none" }
  | { kind: "offer"; deviceZone: string; profileZone: string }
  | { kind: "return"; homeZone: string; awayZone: string };

export interface TravelPromptInput {
  // The acting profile IS the login's own profile. FALSE is the common case for a
  // caregiver acting for someone else, and it is the whole gate: a member holding
  // the traveller's phone must never be offered a switch that would move another
  // person's day to where THIS device happens to be.
  ownProfile: boolean;
  // Intl.DateTimeFormat().resolvedOptions().timeZone, or null when the browser
  // would not say.
  deviceZone: string | null;
  // The profile's stored zone — what its day currently runs on.
  profileZone: string;
  // The zone recorded when the one-tap switch moved the day, i.e. where "home" is
  // while the profile is away. Null when the profile is not away.
  homeZone: string | null;
  // The device zone the person last dismissed an offer for. A dismissal sticks for
  // THAT ZONE until the zone changes again — no daily nag on a long trip somebody
  // is deliberately spending on home time.
  dismissedZone: string | null;
}

export function travelPrompt(input: TravelPromptInput): TravelPrompt {
  const { ownProfile, deviceZone, profileZone, dismissedZone } = input;
  if (!ownProfile) return { kind: "none" };
  if (!deviceZone || !isValidTimezone(deviceZone)) return { kind: "none" };
  // Nothing to say when the day is already running where the device is.
  if (deviceZone === profileZone) return { kind: "none" };
  // A `timezone_home` equal to the profile's current zone is stale bookkeeping, not
  // a trip — treat it as absent so it can never manufacture a return prompt.
  const homeZone = input.homeZone === profileZone ? null : input.homeZone;
  // Both directions are offers. A permanently tunnelled device reporting home
  // should ask once, not on every page view.
  if (dismissedZone && dismissedZone === deviceZone) return { kind: "none" };
  if (homeZone && deviceZone === homeZone) {
    return { kind: "return", homeZone, awayZone: profileZone };
  }
  return { kind: "offer", deviceZone, profileZone };
}

// A zone's place name, for copy: "Asia/Tokyo" → "Tokyo",
// "America/Argentina/Buenos_Aires" → "Buenos Aires". The offset belongs in the
// settings picker, where a person is choosing between zones; here they are being
// told where they are, and they already know.
export function zonePlaceLabel(tz: string): string {
  const tail = tz.split("/").pop() ?? tz;
  return tail.replaceAll("_", " ");
}

export function travelOfferText(deviceZone: string): string {
  return `Your device is on ${zonePlaceLabel(deviceZone)} time — move your day there?`;
}

export function travelReturnOfferText(homeZone: string): string {
  return `Your device is back on ${zonePlaceLabel(homeZone)} time — move your day back?`;
}
