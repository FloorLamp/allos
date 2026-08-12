// The digest time SUGGESTION (#2217). PURE: no DB, no clock, no network.
//
// #2211 removed `auto` from the digest. `auto`'s real job was "the user cannot compute
// the right time themselves" — which is true, since nobody knows their own p90 sync
// arrival. This module is that job done VISIBLY: the app tells the user the number
// instead of silently being it, and the user's tap is the write (#1505).
//
// The measured defect it exists to end, profile 1, 2026-08-06 — a configured 07:00
// digest against 13 nights of sleep-row arrivals:
//
//   06:02 06:06 06:14 06:26 06:47 06:50 07:04 07:11 07:26 07:26 07:30 07:42 07:48
//                                       └───── 7 of 13 arrive after 07:00 ─────┘
//
// The digest shipped without last night's sleep on 7 of 13 mornings and never said so.
//
// ── TWO STATISTICS, DELIBERATELY ─────────────────────────────────────────────
//
// The TRIGGER is the MEDIAN: "the configured time loses more often than not" is exactly
// a statement about the median, and nothing else. It keeps the ask honest — a time that
// wins 60% of mornings is not worth interrupting anyone about.
//
// The PROPOSAL is the P90, because the point of moving is to STOP LOSING, not to lose
// slightly less often. Proposing the median would hand someone a time that fails half
// their mornings, which is the same defect with a different number on it.
//
// They are not two computations. `arrivalStatistics` (#2214) returns both minutes from
// ONE admitted sample in one pass, so the claim this module makes and the time it
// proposes can never describe two different distributions (#2217 constraint 6 / #221).
//
// ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
//
// It never writes. Not the time, not the mode, not anything (constraint 1). The engine
// DETECTS and SUGGESTS; the tap is the write, and declining is a first-class outcome
// rather than a deferral — a dismissed suggestion is dismissed.
//
// It is silent in DYNAMIC mode (constraint 2). There the stored minute is a FLOOR, not
// a send time, and a floor that "loses" is doing exactly its job: Dynamic already waits
// for the arrival this suggestion is about.

import type { Finding } from "./findings";
import { isSuppressed, type SuppressionRecord } from "./upcoming-suppress";
import {
  formatNotifyTime,
  MINUTES_PER_DAY,
  tickGridMinutes,
} from "./notifications/schedule";
import type {
  ArrivalStatistics,
  DigestMode,
} from "./notifications/digest-schedule";
import type { NotificationAction } from "./notifications/types";
import { formatClockMinutes, type TimeFormat } from "./format-date";
import { GLYPH } from "./notifications/glyphs";

// The dedupeKey namespace, registered in RULE_FINDING_REGISTRY.
export const DIGEST_TIME_PREFIX = "digest-time:";

// ── The picker grid (#2216) ──────────────────────────────────────────────────
//
// The app must never propose a minute the instance's tick cannot hit, so the
// proposal snaps onto the SAME grid the picker offers and the off-grid warning
// checks: `tickGridMinutes` (lib/notifications/schedule.ts) over the OBSERVED
// cadence — one grid, derived once, for every consumer. The snap lives HERE, at
// the consumer, not inside #2214's statistic: the statistic answers "when does
// the data land", and quantising that answer is this proposal's own concern.

/**
 * Snap a proposed minute UP onto the picker grid — never earlier than the minute it
 * was given, because the whole point of the proposal is to CLEAR the arrival tail and
 * rounding down would re-open the failure it is fixing.
 *
 * A snap that would leave the day lands on the day's last grid point instead; a
 * proposal is a send time, and a send time tomorrow is not a send time.
 */
export function snapProposalMinute(
  minute: number,
  tickMinutes: number
): number {
  const grid = tickGridMinutes(tickMinutes);
  const snapped = Math.ceil(Math.max(0, minute) / grid) * grid;
  const lastOfDay = MINUTES_PER_DAY - grid;
  return Math.min(snapped, lastOfDay);
}

// ── The episode key, and why it is shaped like this ──────────────────────────
//
// Constraint 3: an episode-scoped dismissal that SURVIVES STATISTICAL JITTER. #2214
// measures the arrival p90 moving by up to 11 minutes on leave-one-night-out, so a key
// that named the statistic directly would mint a new episode most weeks and re-ask a
// question the user has already answered. Someone who has decided 07:00 is right for
// them must be able to keep it.
//
// The key names the two numbers the copy states — the configured time and the proposal
// — and the decision that reads it is a RATCHET rather than an equality test:
//
//   • a dismissal at (configured, proposed) suppresses every later evaluation of the
//     SAME configured time whose proposal has not moved at least
//     DIGEST_TIME_MATERIAL_MOVE_MIN minutes LATER;
//   • a proposal that moves EARLIER never re-asks, at any distance — the situation the
//     user declined to act on has only got smaller;
//   • changing the CONFIGURED time is a new question and correctly re-arms: the user
//     just made a fresh decision about exactly this setting.
//
// Bands would have been the obvious alternative and are worse: a gap oscillating across
// a band boundary re-asks on a two-minute move, which is precisely the jitter this has
// to absorb. The ratchet has no boundaries.
export const DIGEST_TIME_MATERIAL_MOVE_MIN = 30;

/** `digest-time:<configuredMinute>:<proposedMinute>` — the episode's identity. */
export function digestTimeEpisodeKey(
  configuredMinute: number,
  proposedMinute: number
): string {
  return `${digestTimeFamily(configuredMinute)}:${proposedMinute}`;
}

/**
 * The TOPIC the key above is an episode of — "your configured send time predates your
 * data" — declared for the repeat-dismissal family lookup (#2543/#2386). Minted by the
 * key itself, so the stem cannot drift wider than the identity it belongs to.
 *
 * The stem is the CONFIGURED minute and the episode is the proposal, which falls straight
 * out of the ratchet above: "changing the CONFIGURED time is a new question and correctly
 * re-arms", so a re-armed suggestion is a NEW family whose count starts at zero — the
 * #203/#482 evidence-in-identity discipline, already in force here before anything
 * counted it.
 *
 * Two stored keys under one stem therefore mean the person declined this at one proposal
 * and declined it again at a proposal at least DIGEST_TIME_MATERIAL_MOVE_MIN later. The
 * ratchet is what makes the second a genuinely separate raising rather than jitter, which
 * is what makes the count worth reading at all.
 */
export function digestTimeFamily(configuredMinute: number): string {
  return `${DIGEST_TIME_PREFIX}${configuredMinute}`;
}

/** The two minutes back out of a stored key, or null when it is not one of ours. */
export function parseDigestTimeEpisodeKey(
  key: string
): { configuredMinute: number; proposedMinute: number } | null {
  if (!key.startsWith(DIGEST_TIME_PREFIX)) return null;
  const [c, p] = key.slice(DIGEST_TIME_PREFIX.length).split(":");
  const configuredMinute = Number(c);
  const proposedMinute = Number(p);
  if (!Number.isInteger(configuredMinute) || configuredMinute < 0) return null;
  if (!Number.isInteger(proposedMinute) || proposedMinute < 0) return null;
  return { configuredMinute, proposedMinute };
}

// ── The suggestion ───────────────────────────────────────────────────────────

export interface DigestTimeSuggestionInput {
  /** The digest's mode. Dynamic is silent — a floor is not a send time. */
  mode: DigestMode;
  /** The configured send time, or null when the digest is off. */
  configuredMinute: number | null;
  /**
   * Whether the digest's Sleep section is on (#2255). Declared here, beside the mode
   * and the time, because it is the same KIND of fact and belongs to the same
   * decision — `describeDigestSchedule` already takes it for exactly this reason.
   */
  sleepSectionEnabled: boolean;
  /** The measured arrival distribution (#2214), or its stated no-answer. */
  stats: ArrivalStatistics;
  /** The scheduler's OBSERVED tick cadence — what the proposal is snapped to. */
  tickMinutes: number;
}

export interface DigestTimeSuggestion {
  /** What is configured now. */
  configuredMinute: number;
  /** The arrival median — the TRIGGER: later than the configured time. */
  medianMinute: number;
  /** The arrival p90 — what the proposal clears. */
  p90Minute: number;
  /** The p90, snapped up onto the picker grid. What "Use …" would write. */
  proposedMinute: number;
  /** Admitted mornings behind both statistics. */
  nights: number;
  /** The episode key, on the shared suppression bus. */
  dedupeKey: string;
}

/**
 * The suggestion, or null when there is nothing honest to say.
 *
 * SILENT WHEN (each for its own reason, none foldable into another):
 *   • the digest is OFF — there is no send time to be wrong;
 *   • the SLEEP SECTION is off (#2255) — the whole premise is "your digest goes out
 *     before last night's sleep arrives", and a digest that carries no sleep has
 *     nothing to miss. Firing anyway offered a Dynamic exit into a mode whose own
 *     caption immediately says "there is nothing to wait for";
 *   • the mode is DYNAMIC — the minute is a floor, and Dynamic already waits;
 *   • the arrival statistic has no answer — whichever of its four reasons applies.
 *     `thin-sample` resolves by waiting, `no-source`/`no-arrivals` resolve by a change
 *     in what syncs, and `dispersed` (a shift worker's genuine rhythm) does not resolve
 *     at all. None of them can carry a percentile, so none of them can carry a claim;
 *   • the configured time WINS more often than not — the median is at or before it;
 *   • the configured time already clears the p90 — there is nothing to move to.
 *
 * The last two are stated separately even though the median test implies the p90 one
 * on any real sample: they are two different reasons to stay quiet, and reading the
 * code should not require re-deriving that median ≤ p90.
 */
export function digestTimeSuggestion(
  input: DigestTimeSuggestionInput
): DigestTimeSuggestion | null {
  if (input.configuredMinute == null) return null;
  if (!input.sleepSectionEnabled) return null;
  if (input.mode !== "static") return null;
  if (!input.stats.available) return null;

  const configuredMinute = input.configuredMinute;
  const { medianMinute, p90Minute, nights } = input.stats;

  // "More often than not" is exactly a median, and nothing else (constraint 6).
  if (medianMinute <= configuredMinute) return null;
  // Already clearing the tail: there is no better time to propose.
  if (configuredMinute >= p90Minute) return null;

  const proposedMinute = snapProposalMinute(p90Minute, input.tickMinutes);
  // A grid coarse enough to snap the proposal back onto (or before) the configured
  // time leaves nothing to propose. Degenerate, but honest: say nothing rather than
  // offer someone the time they already have.
  if (proposedMinute <= configuredMinute) return null;

  return {
    configuredMinute,
    medianMinute,
    p90Minute,
    proposedMinute,
    nights,
    dedupeKey: digestTimeEpisodeKey(configuredMinute, proposedMinute),
  };
}

/**
 * Is this suggestion inside a dismissed episode? The ratchet described above, read
 * over the profile's whole suppression map: a dismissal on the same configured time
 * holds until the proposal has moved at least DIGEST_TIME_MATERIAL_MOVE_MIN later.
 *
 * The map is scanned rather than looked up because the stored key names the proposal
 * AT DISMISSAL, which is exactly the number a jitter-tolerant comparison needs and
 * exactly the number an equality lookup would throw away.
 */
export function digestTimeSuggestionSuppressed(
  suggestion: Pick<DigestTimeSuggestion, "configuredMinute" | "proposedMinute">,
  map: Map<string, SuppressionRecord>,
  today: string
): boolean {
  for (const [key, record] of map) {
    const parsed = parseDigestTimeEpisodeKey(key);
    if (!parsed) continue;
    if (parsed.configuredMinute !== suggestion.configuredMinute) continue;
    if (!isSuppressed(record, today)) continue;
    if (
      suggestion.proposedMinute <
      parsed.proposedMinute + DIGEST_TIME_MATERIAL_MOVE_MIN
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The ONE answer both surfaces read (constraint 5). The Settings row and the in-digest
 * line are the same finding with the same episode key, so dismissing either dismisses
 * both — two surfaces asking one question twice is the noise this is bounded against.
 */
export function activeDigestTimeSuggestion(
  input: DigestTimeSuggestionInput,
  map: Map<string, SuppressionRecord>,
  today: string
): DigestTimeSuggestion | null {
  const s = digestTimeSuggestion(input);
  if (!s) return null;
  return digestTimeSuggestionSuppressed(s, map, today) ? null : s;
}

// ── Copy ─────────────────────────────────────────────────────────────────────
//
// It states the measured facts and NOTHING about the person (#992/#716). No "you
// should", no streak, no judgement — two clock times and what follows from them.
//
// Both sentences quote the PROPOSED minute rather than the raw p90, so the number in
// the claim and the number on the button are the same number. The proposal is never
// earlier than the p90, so "lands by <proposed>" is if anything more true than "lands
// by <p90>" would have been.

export interface DigestTimeSuggestionCopy {
  /** "Last night's sleep usually lands by 07:40." */
  headline: string;
  /** "Your digest sends at 07:00, so it often goes out before the data arrives." */
  detail: string;
  /**
   * Why the exits are ranked the way they are (#2255 §2), in numbers rather than
   * adjectives. Both times it quotes are already on the buttons beside it.
   */
  tradeoff: string;
  /** What the two statistics were measured over. */
  evidence: string;
  /** The write exit. */
  useLabel: string;
  /** The other exit — #2211's Dynamic mode, named by the label its picker uses. */
  dynamicLabel: string;
  /** Declining. A dismissal, not a deferral. */
  dismissLabel: string;
  /** The whole claim as one line, for the digest message. */
  line: string;
}

/**
 * `timeFormat` renders the two clock times for a surface that HAS a login — the
 * Settings card, through the #964/#1163 seam every other clock render already uses.
 * It defaults to 24h, which is what the login-less consumers need: the in-digest
 * `line` and the Telegram keyboard have a profile but no login in context and keep
 * their documented fixed per-channel format (see the rule at the top of
 * lib/format-date.ts). This is DISPLAY only — `formatNotifyTime` stays the canonical
 * serializer for stored values, form field values and wire tokens.
 */
export function digestTimeSuggestionCopy(
  s: DigestTimeSuggestion,
  timeFormat: TimeFormat = "24h"
): DigestTimeSuggestionCopy {
  const proposed = formatClockMinutes(timeFormat, s.proposedMinute);
  const configured = formatClockMinutes(timeFormat, s.configuredMinute);
  const headline = `Last night’s sleep usually lands by ${proposed}.`;
  const detail = `Your digest sends at ${configured}, so it often goes out before the data arrives.`;
  return {
    headline,
    detail,
    // The RANKING, argued rather than asserted by button colour (#2255 §2). Moving the
    // static time costs the full gap every morning; Dynamic keeps the current time as
    // its floor and usually sends earlier than the proposal, bounded by a deadline.
    // Static-later wins only on predictability, and this is the sentence that says so.
    tradeoff: `“As soon as it’s ready” usually sends earlier than ${proposed}; ${proposed} keeps a fixed time.`,
    evidence: `Measured over ${s.nights} morning${s.nights === 1 ? "" : "s"}.`,
    useLabel: `Use ${proposed}`,
    // NOT "Switch to Dynamic". "Dynamic" is a word the user never sees: #2211 labels
    // the modes by INTENT rather than by mechanism, and its picker calls this one "As
    // soon as it's ready". The exit is that mode; the button says what the picker says.
    dynamicLabel: "Switch to “As soon as it’s ready”",
    // NOT "Not now" (#2255 §3). This exit is an episode-scoped dismissal that survives
    // statistical jitter — it does not come back next week — so a label that reads as
    // a snooze under-promises what the tap actually does.
    dismissLabel: "No thanks",
    line: `${headline} ${detail}`,
  };
}

/**
 * The Finding envelope. COACHING tier: calm, hideable, never an Upcoming safety row,
 * never an escalation, never its own send (constraint 4).
 *
 * `tone: "info"` on purpose — a send time that predates its data is neither a caution
 * nor a failure, and toning it as one would be exactly the editorialising the tone
 * contract forbids.
 */
export function digestTimeSuggestionFinding(s: DigestTimeSuggestion): Finding {
  const copy = digestTimeSuggestionCopy(s);
  return {
    domain: "digest-time",
    dedupeKey: s.dedupeKey,
    // The topic this proposal is an episode of (#2543). Read only by the repeat-
    // dismissal family lookup; the ratchet above still owns suppression.
    episodeFamily: digestTimeFamily(s.configuredMinute),
    title: copy.headline,
    detail: copy.detail,
    evidence: copy.evidence,
    tone: "info",
  };
}

/**
 * The in-digest line (owner decision, 2026-08-06). ONE line, below the digest's
 * content, present only while the suggestion is firing.
 *
 * WHY THIS IS PERMISSIBLE UNDER THE CONTACT-CONSENT RULE. A line added to an
 * already-consented send is not an increase in contact. It never causes a send, is
 * never its own send, and never lowers the digest's "is there anything to say?" bar —
 * `buildDigest` appends it only to a message that already exists. That is the same
 * ride-along shape #1670's right-sizing suggestion has on the practice nudge and
 * #1757's portal ask has on the digest: reach without a new interruption.
 *
 * It exists because the person this issue is about is precisely the person who does
 * NOT reopen Settings — reaching only surfaces you must open to see inverts the
 * purpose of a feature whose whole job is to run without you (#1685).
 */
export function digestTimeSuggestionLine(s: DigestTimeSuggestion): string {
  return `${GLYPH.schedule} ${digestTimeSuggestionCopy(s).line}`;
}

/** The digest section's heading. Declared here so the gather and the tests agree. */
export const DIGEST_TIME_SECTION_HEADING = "Digest timing";

// ── The in-digest keyboard ───────────────────────────────────────────────────
//
// The escape hatch belongs on the surface that raised the question, not only on a
// settings page you visit later (#1505's Take/Skip/Demote precedent, #1714's ⚙️ Tune
// one control over). So the same three exits ride the message.
//
// Token namespaces are declared here, beside the copy, so the parser and the renderer
// can never disagree about the wire format. Each carries the profile id as a CROSS-CHECK
// only and the digest's own DATE, so a tap on yesterday's message is refused rather
// than acted on from rolled-over context — and neither carries the proposed minute,
// because the handler re-resolves the live suggestion before writing anything.

export const DIGEST_TIME_USE_PREFIX = "dgtuse";
export const DIGEST_TIME_DYNAMIC_PREFIX = "dgtdyn";
export const DIGEST_TIME_DISMISS_PREFIX = "dgtno";

export function digestTimeUseToken(profileId: number, date: string): string {
  return `${DIGEST_TIME_USE_PREFIX}:${profileId}:${date}`;
}

export function digestTimeDynamicToken(
  profileId: number,
  date: string
): string {
  return `${DIGEST_TIME_DYNAMIC_PREFIX}:${profileId}:${date}`;
}

export function digestTimeDismissToken(
  profileId: number,
  date: string
): string {
  return `${DIGEST_TIME_DISMISS_PREFIX}:${profileId}:${date}`;
}

/**
 * The three buttons, in reach order: the mode that WAITS for the arrival, the static
 * time that schedules past it, then declining. A Telegram button has ~30 usable
 * characters beside its icon, so the first label is the picker's own words trimmed of
 * the verb.
 *
 * Dynamic leads (#2255 §2) for the same reason it is the card's primary action, and
 * the two orders are deliberately the same one: bumping the static time costs the
 * user the full gap every morning, while Dynamic keeps the current time as its floor,
 * usually sends earlier than the proposal, and is deadline-bounded. Static-later wins
 * only on predictability. The Settings card ARGUES that in a sentence; a keyboard has
 * no room for one, so here the argument is carried by order alone.
 */
export function digestTimeActions(
  profileId: number,
  date: string,
  s: DigestTimeSuggestion
): NotificationAction[] {
  return [
    {
      label: `${GLYPH.waiting} As soon as it’s ready`,
      data: digestTimeDynamicToken(profileId, date),
      row: "digest-time",
    },
    {
      // The WIRE format, not a display pref: a Telegram send has a profile but no
      // login in context, so it keeps its fixed 24-h channel format.
      label: `${GLYPH.schedule} Use ${formatNotifyTime(s.proposedMinute)}`,
      data: digestTimeUseToken(profileId, date),
      row: "digest-time",
    },
    {
      label: `${GLYPH.muted} No thanks`,
      data: digestTimeDismissToken(profileId, date),
      row: "digest-time-decline",
    },
  ];
}

/** What each tap says back. States the CONSEQUENCE, in the same words as the copy. */
export function digestTimeUseAnswer(minute: number): string {
  return `Your digest now sends at ${formatNotifyTime(minute)}.`;
}

export function digestTimeDynamicAnswer(minute: number): string {
  return `Your digest now sends as soon as last night’s sleep lands, never before ${formatNotifyTime(minute)}.`;
}

export const DIGEST_TIME_DISMISS_ANSWER =
  "Left as it is. This won’t come back unless your sleep starts landing much later.";

/**
 * What one of the three exits did. TYPED, because each of them can legitimately
 * REFUSE: every exit re-resolves the live suggestion before writing, so a tap from a
 * stale tab — or on a suggestion that stopped firing while the message sat in a chat —
 * writes nothing, and the surface must render that rather than confirming a write that
 * did not happen.
 */
export type DigestTimeExitResult =
  { ok: true; minute: number } | { ok: false; reason: "stale" };

/** What a refused exit says. One sentence, no blame, no invented cause. */
export const DIGEST_TIME_STALE_TEXT =
  "That suggestion no longer applies — your digest time is unchanged.";
