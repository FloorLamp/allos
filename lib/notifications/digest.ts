// Per-profile morning digest — PURE assembly + rendering, no
// DB/network, so both are unit-tested in lib/__tests__. The DB gather lives in
// ./digest-data. buildDigest turns the gathered facts into a section/line model,
// collapsing empty sections and returning null when there's nothing worth sending;
// renderDigestMessage turns that model into the Telegram message (kept separate
// from assembly per the issue). The title always names the profile — a chat may be
// shared by several profiles (the chat-id ambiguity fix).

import type { NotificationAction, NotificationMessage } from "./types";
import type { ActivityType, SupplementKind } from "../types";
import type { BandGroup, UpcomingDomain } from "../upcoming";
import { fmtWeight, fmtDistance } from "../units";
import { intakeWindowNoun, intakeItemNoun } from "./supplement-format";
import { situationActivationLine } from "../situations";
import { heldSummaryLine } from "../supplement-schedule";
import { buildUpcomingDigest } from "./upcoming-digest";
import { offerTextTail } from "./offer-tail";
import { joinBody } from "./rich-text";
import { sriPresentation } from "../sleep-regularity";
import { sleepVerdictPhrase } from "../sleep-summary";
import {
  intakeDeltaLine,
  intakeGapExplainedBy,
  type IntakeDeltas,
} from "../intake-deltas";
import { isTrainingSignalKey } from "../workout-nudge";

// Capitalize the first letter of a noun for use at the start of a line
// ("medications" → "Medications").
function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export interface DigestActivity {
  title: string;
  type: ActivityType;
  durationMin: number | null;
  distanceKm: number | null;
}

export interface DigestFlaggedBiomarker {
  // Canonical-preferred display name: the reading's canonical name when it has
  // one, else its raw stored name (issue #283 — the hero deep-links by canonical
  // name, so the two must agree).
  name: string;
  // The canonical name when the reading is canonicalized, else null — gates
  // whether a per-analyte series deep-link exists (mirrors biomarkerItems).
  canonicalName?: string | null;
  value: string | null;
  flag: string;
}

// Collapse repeat flags of one analyte to its NEWEST reading (issue #283): the
// input is newest-first (the read orders by created_at DESC), so keep the first
// occurrence per lowercased name. Without this, two flagged readings of one
// analyte yielded duplicate React keys on the hero and duplicate digest lines.
export function dedupeFlaggedByAnalyte(
  rows: DigestFlaggedBiomarker[]
): DigestFlaggedBiomarker[] {
  const seen = new Set<string>();
  const out: DigestFlaggedBiomarker[] = [];
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Last night's sleep facts for the calm "how'd I sleep" digest section (#1117),
// all derived from the SAME main-overnight-session (#1118) and SRI (#160)
// computations the rest trigger and Trends use — one computation (#221). Minutes
// throughout. The nap is kept SEPARATE from the overnight figure (never folded in).
export interface DigestSleep {
  lastNightMin: number; // main overnight session, last recorded night
  baselineMin: number; // recent-nights baseline (mean)
  deepMin?: number | null; // deep-stage minutes when the source reports stages
  remMin?: number | null; // REM-stage minutes when reported
  napMin?: number | null; // same-day nap total, shown on its own line when > 0
  sri?: number | null; // Sleep Regularity Index when the signal is meaningful
}

export interface DigestInput {
  profileName: string;
  // An OPEN illness episode's one-line headline (issue #859 item 5), preformatted from
  // the SAME assembly the hero/household line use (episodeHeadline) — no second engine.
  // Null when the profile isn't currently sick. When present the digest LEADS with it.
  openEpisodeLine?: string | null;
  // Today
  doseCount: number; // supplement/medication doses scheduled today
  // The distinct kinds among the profile's scheduled/adhered intake items,
  // choosing the reminder noun so a medications-only profile isn't told
  // "supplements" (#380). Optional/empty ⇒ "supplements" (back-compat default).
  intakeKinds?: SupplementKind[];
  // The merged "what's due" list (issue #1108): the ALREADY-BANDED collectUpcoming
  // output for today (groupUpcoming) — doses, refills, appointments, planned care,
  // preventive, retests, goals, training, … Replaces the digest's own goals/dose
  // computation so snooze/dismiss (the findings bus) and training-restriction govern
  // the whole morning message and the page/push can't disagree (#221). buildDigest
  // formats it into the Today section (doses summarized by the count line above, so
  // they're excluded from the banded lines to avoid double-counting).
  todayGroups: BandGroup[];
  // The absolute public app URL, when configured — used to make the broken-sync lines'
  // hrefs tappable (#1685), the same deepLinkBase convention the food/preventive nudges
  // use. Empty/absent ⇒ the lines render without a link rather than a broken relative one.
  deepLinkBase?: string;
  // Count of situational intake items due TODAY because their situation is active
  // (issue #662 item 1) — the optional digest mention of the same "N situational
  // items now active" the situations bar shows. Optional/0 ⇒ the line is omitted.
  situationalActiveCount?: number;
  // Count of active intake items currently HELD by a pause situation (#1296) — the
  // digest's honest mention of "N items held by <situation>" so a forgotten-active
  // pause situation is discoverable, never a silent reminder blackout. `heldSituation`
  // names the situation for the line (the first when several hold). Optional/0 ⇒
  // omitted.
  heldCount?: number;
  heldSituation?: string | null;
  // The DERIVED-context acknowledgment lines (#1292 Poor sleep, #1298 Period) — the
  // SAME basis-aware lines the Supplements bar + check-in disclosure show, shared so a
  // Telegram-first user isn't surprised by the extra due items (#662/#221). Each is a
  // ready-to-render string; empty ⇒ no derived context is on / no keyed items.
  derivedSituationLines?: string[];
  // The outdoor-session planning line(s) (#1724 part 5) — the SAME planningLine result
  // the calm Upcoming planning item renders, so the glance and the planning surface can
  // never disagree (#221). Empty ⇒ no plan is worth surfacing this week.
  weatherPlanLines?: string[];
  // The weather-aware light-exposure line (#1723 part 1) — "Sunny, UV moderate until
  // 4pm — good window for light exposure." Rendered by the pure lightExposureLine over
  // the ALREADY-SYNCED weather/UV cache, gated by the named favorable-conditions
  // predicate plus a relevance test, so a rainy day, a missing forecast or a profile
  // this isn't about produces nothing. It rides THIS message; no send is created.
  // Its own optional field so per-category demotion (#1714) has one switch.
  lightExposureLine?: string | null;
  // The Today STEP line (#1723 part 2) — the declared daily target, stated only when
  // the trailing average sits below it (restating a target the reader already meets is
  // not news). Null on every other day and for every profile with no declared target.
  stepsTodayLine?: string | null;
  // Yesterday
  activities: DigestActivity[];
  // Supplement adherence yesterday, or null when nothing was due. `skipped`
  // counts deliberate skips (#232), surfaced alongside taken.
  adherence: { taken: number; skipped: number; due: number } | null;
  // The state changes across the pushed tier (#1505 part 3), classified by the ONE
  // shared `classifyIntakeDeltas` the weekly recap and the household card also read.
  // Rendered here through the SAME `intakeDeltaLine` formatter those two use — the
  // structured form is carried rather than the finished string so the digest can also
  // decide whether the delta and the adherence fraction are stating one fact twice
  // (#1819 item 6). Empty/absent on a quiet window, which is the signal to say
  // nothing: a fraction always has a value, but a delta only exists when something
  // actually changed.
  intakeDeltas?: IntakeDeltas | null;
  // Weight logged yesterday, canonical kg. Rendered in kg by policy: the
  // notification has no login-unit context (multiple logins, each with its own
  // weight preference, can watch one profile), so all notification builders emit
  // canonical kg — the same policy the weekly recap documents. Rounded via the
  // shared fmtWeight formatter rather than printed as the raw stored float (#380).
  weightKg: number | null;
  // Yesterday's steps against the declared daily target (#1723 part 2), in the #1712
  // verdict shape ("8,400 steps ▲ target met" / "5,100 of 8,000 steps"). Null when no
  // target is declared or no reading exists — the digest states a comparison or says
  // nothing; it never prints a lonely number for the reader to evaluate.
  stepsLine?: string | null;
  // New since the last digest
  newFlaggedBiomarkers: DigestFlaggedBiomarker[];
  newDocumentLabels: string[];
  // The RECENT-CHANGES lines (#1713), already ranked, floored and capped by the ONE
  // shared collector (lib/recent-changes.ts + lib/queries/recent-changes.ts) that the
  // Household member card reads at 7 days and this reads at 24 hours. They join the
  // existing "New since the last digest" section, which is what finally makes it the
  // honest "what changed" section it was always trying to be: out-of-range vitals,
  // mood/check-in, symptoms and overnight data arrival can appear at last.
  //
  // Empty on a quiet 24h, and an empty list renders NO section — the digest must never
  // manufacture news to fill space (the same rule the delta line already follows).
  recentChangeLines?: string[];
  // Last night's sleep (issue #1117), or null when the sleep summary is off or
  // there's no fresh sleep data. When present the digest gets a calm Sleep section.
  sleep?: DigestSleep | null;
  // The GUARANTEED access tail (#1505): the collapsed "Log other (N for <slot>)" action
  // for this profile's `may` items, or null when the profile has none on offer today.
  // Its presence also lowers the "is there anything to say?" bar to zero — see
  // buildDigest — because for a tap-only user this button IS the digest's job.
  offerTail?: NotificationAction | null;
  // How many may items that tail covers, for the plain-text channels that cannot
  // render an expandable keyboard (Web Push, Home Assistant).
  offerCount?: number;
  // Today's recommended workout, preformatted by the SAME formatter the dedicated
  // nudge uses (#1712 §2 / #221) in its BARE variant — the standalone "Today:" prefix
  // is right in the nudge and restates the heading here (#1819 item 3). Null when
  // there's no recommendation — no routine, a restricted profile, or the presence
  // gates hold.
  workoutPreview?: string | null;
  // The weekly-progress phrase for training targets (#1819 item 4) — "2 of 4 training
  // targets on pace — behind on Back", from the SAME paced set the Upcoming training
  // items are drawn from. It REPLACES the band's "N training targets" count, which was
  // a number carrying neither progress nor what is lagging. Null for a profile with no
  // weekly targets, and never applied to a band whose `training` items are something
  // else (an outdoor plan, an endurance event).
  trainingPaceLine?: string | null;
  // The collapsed ⚙️ Tune control (#1714), or null when today's message carries
  // nothing tunable. Unlike the offer tail it does NOT lower the "is there anything to
  // say?" bar: a message that exists only to offer its own preferences is not a
  // message, so buildDigest still returns null when there are no sections and no offer
  // tail. The control tunes a digest; it never justifies one.
  tuneTail?: NotificationAction | null;
}

export interface DigestSection {
  heading: string;
  lines: string[];
}

export interface DigestModel {
  title: string;
  sections: DigestSection[];
  // The offer count, carried so renderDigestMessage can put the TEXT tail on the
  // channels that need it and nowhere else (#1712).
  offerCount?: number;
  // Carried through assembly so renderDigestMessage can attach it as the message's
  // FIRST inline button — first because it is the one affordance that is always
  // correct to offer, regardless of what else the day held.
  offerTail?: NotificationAction | null;
  // The collapsed ⚙️ Tune control (#1714), rendered AFTER the offer tail: access to
  // your own items outranks tuning what the message says about them.
  tuneTail?: NotificationAction | null;
}

// Human sleep duration: "7h 20m", "8h", "45m". Minutes in, rounded.
function fmtSleepDuration(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Short key stat for an activity line: distance for cardio, else duration.
function activityStat(a: DigestActivity): string {
  if (a.type === "cardio" && a.distanceKm != null) {
    // Canonical km per the notification unit policy (a chat has no login-unit
    // context), rounded via the shared formatter rather than the raw stored float
    // (#1109) — matches the adjacent fmtWeight line.
    return ` — ${fmtDistance(a.distanceKm, "km")}`;
  }
  if (a.durationMin != null) return ` — ${a.durationMin} min`;
  return "";
}

// Doses are summarized by the Today dose-count headline, so they're dropped from
// the banded "what's due" lines to avoid double-counting (issue #1108).
const DOSE_EXCLUDED_FROM_BANDS: readonly UpcomingDomain[] = ["dose"];

// A band of at most this many items NAMES them instead of counting them (#1819 item
// 5). "Overdue: 1 screening, 2 labs" is a count with the subject removed; at this size
// the names fit and the count never did any work. Above it, naming stops fitting on a
// line and the count is genuinely the right shape.
const BAND_NAME_AT_MOST = 3;

// Assemble the digest model, or null when every section is empty (so the tick
// sends nothing rather than a hollow "nothing to report").
export function buildDigest(input: DigestInput): DigestModel | null {
  const sections: DigestSection[] = [];

  // Name intake items by their actual kinds so a medications-only profile isn't
  // told "supplements" (#380): `noun` is the plural label ("Medications:"),
  // `itemNoun` the singular modifier ("N medication doses").
  const kinds = input.intakeKinds ?? [];
  const noun = intakeWindowNoun(kinds);
  const itemNoun = intakeItemNoun(kinds);

  // Illness: an open episode LEADS the digest (issue #859 item 5) instead of
  // business-as-usual coaching copy. One line, from the shared episode assembly.
  if (input.openEpisodeLine) {
    sections.push({
      heading: "Illness",
      lines: [`🤒 ${input.openEpisodeLine}`],
    });
  }

  // Today: what's on deck — the MERGED due list (issue #1108). One engine (#221): a
  // formatter over collectUpcoming (the banded `todayGroups`), so snooze/dismiss and
  // training-restriction apply to the whole morning message. The dose count is the
  // glance headline; the banded lines cover everything else; the "why" highlights
  // (#656) explain the important items.
  const todayLines: string[] = [];
  // Dose glance headline — the count of DUE doses from collectUpcoming (bus-honored
  // + #558 predicted-training-day, both applied by collectUpcoming's dose items).
  if (input.doseCount > 0) {
    todayLines.push(
      `💊 ${input.doseCount} ${itemNoun} dose${input.doseCount === 1 ? "" : "s"} scheduled`
    );
  }
  // Situation-activation mention (#662 item 1): the SAME "N situational items now
  // active" line the situations bar renders, via the one shared formatter.
  const situationLine = situationActivationLine(
    input.situationalActiveCount ?? 0
  );
  if (situationLine) todayLines.push(`🧭 ${situationLine}`);
  // Held-items mention (#1296): the visible held state in the morning message, via the
  // one shared heldSummaryLine formatter — so a pause situation silencing reminders is
  // never a silent blackout.
  const heldLine =
    input.heldSituation && (input.heldCount ?? 0) > 0
      ? heldSummaryLine(input.heldCount ?? 0, input.heldSituation)
      : null;
  if (heldLine) todayLines.push(`⏸️ ${heldLine}`);
  // Derived-context acknowledgment (#1292/#1298): the SAME basis-aware lines the bar +
  // check-in show ("Rough night (…) — N sleep-support items active today (auto)";
  // "Period logged — N items active"), so the extra due items are never a surprise.
  for (const line of input.derivedSituationLines ?? []) {
    todayLines.push(`🌙 ${line}`);
  }
  // Today's recommended workout (#1712 §2) — a heads-up at 7am, formatted from the
  // SAME recommendation the dedicated nudge builds later (no second engine, no second
  // gather). The nudge is unchanged and remains the actionable prompt with its
  // buttons; the two agree because they format one computation. Rest / on-track /
  // deload states reframe the line exactly as they reframe the nudge, so this is never
  // a blind push.
  if (input.workoutPreview) todayLines.push(input.workoutPreview);

  // The outdoor-session plan (#1724 part 5): "This week: Saturday looks like the best
  // window for your cycling (cycling 1/2)." Rides THIS message — there is no dedicated
  // planning send and this creates none. Its own optional input field (like
  // workoutPreview above) so the per-category demotion control, when it lands, has one
  // category to switch off without touching the rest of the section.
  for (const line of input.weatherPlanLines ?? []) {
    todayLines.push(`\u{1F6B4} ${line}`);
  }

  // The weather-aware light window (#1723 part 1). Present only on a day whose
  // forecast actually supports it, and only for a profile the line is about — the gate
  // lives in the pure predicate, so by the time the line exists there is nothing left
  // to decide here. It states a WINDOW, never an instruction with a deadline.
  if (input.lightExposureLine) {
    todayLines.push(`☀️ ${input.lightExposureLine}`);
  }
  // The daily step target (#1723 part 2), stated only when it is genuinely informative.
  if (input.stepsTodayLine) todayLines.push(`🚶 ${input.stepsTodayLine}`);

  // The banded "what's due" summary + high-priority "why" lines, from the SAME
  // collectUpcoming formatter the Upcoming page/hero read. Doses are EXCLUDED from
  // the per-band counts (the glance line above already summarizes them) so a day of
  // only doses reads as one clean line, not "💊 3 doses" + "Today: 3 doses".
  //
  // Two shapes beyond the bare count (#1819 items 4 and 5): a band of at most
  // BAND_NAME_AT_MOST items NAMES them ("Overdue: colonoscopy · CBC, lipid panel"),
  // because below that size a count withholds the only thing the reader needs; and a
  // band whose `training` items are all weekly targets states the weekly PROGRESS
  // instead of counting them. The training guard is the key namespace, not the domain
  // — an endurance event and an outdoor plan also live in `training`, and the pace
  // phrase is not about them.
  const due = buildUpcomingDigest(input.profileName, input.todayGroups, {
    excludeDomains: DOSE_EXCLUDED_FROM_BANDS,
    nameAtMost: BAND_NAME_AT_MOST,
    phraseFor: (domain, items) =>
      domain === "training" &&
      input.trainingPaceLine &&
      items.every((i) => isTrainingSignalKey(i.key))
        ? input.trainingPaceLine
        : null,
  });
  if (due) {
    // One bullet grammar for the section (#1819 item 5): the band summaries were the
    // only lines in the whole message with no emoji.
    for (const line of due.lines) todayLines.push(`🗓️ ${line}`);
    for (const h of due.highlights) {
      todayLines.push(`⚑ ${h.title} — ${h.reason}`);
    }
    // Broken syncs, named (#1685). The band count above says how many; these say which,
    // and link where the fix lives. Present for as long as the connection is broken and
    // gone the morning after a healthy sync — the signal self-clears because the item
    // behind it does (currentlyFailingProviders / the staleness threshold), so nothing
    // here needs its own lifecycle.
    const base = (input.deepLinkBase ?? "").replace(/\/$/, "");
    for (const s of due.syncIssues) {
      const detail = s.detail ? ` — ${s.detail}` : "";
      const link = base ? ` ${base}${s.href}` : "";
      todayLines.push(`🔌 ${s.title}${detail}${link}`);
    }
  }
  if (todayLines.length) sections.push({ heading: "Today", lines: todayLines });

  // Yesterday: what happened.
  const yLines: string[] = [];
  for (const a of input.activities) {
    yLines.push(`🏋️ ${a.title}${activityStat(a)}`);
  }
  // The delta headline LEADS the intake report (#1505 part 3): "which of the things
  // that push me changed state" is the news; the fraction below is the supporting
  // detail. Rendered through the ONE shared formatter, never recomputed here.
  //
  // …UNLESS the two state one fact twice (#1819 item 6). "🔁 Missed: Glycine (1 day)"
  // above "💊 Supplements: 8/9 taken" is one line's worth of news wearing two bullets:
  // the 1 missing IS the Glycine. When the delta fully explains the gap the two MERGE
  // into "💊 8/9 taken — missed Glycine (1 day)". The divergent cases — a skip, several
  // misses, a resume, a mixed window — keep both lines, because there the fraction and
  // the delta genuinely answer different questions.
  const deltas = input.intakeDeltas ?? null;
  const deltaLine = deltas ? intakeDeltaLine(deltas) : null;
  const adherence = input.adherence;
  // Skips are excluded from the "of N due" figure (they weren't intended doses); a
  // nonzero skip count is shown as a trailing note (#232).
  const intended = adherence ? adherence.due - adherence.skipped : 0;
  const mergedClause =
    deltas && adherence && intended > 0
      ? intakeGapExplainedBy(deltas, intended - adherence.taken)
      : null;
  if (deltaLine && !mergedClause) {
    yLines.push(`🔁 ${deltaLine}`);
  }
  if (adherence) {
    const { taken, skipped } = adherence;
    if (intended <= 0) {
      // Everything due was deliberately skipped — a "0/0 taken" line reads as a
      // bug (#380 nit); state the skips plainly instead.
      yLines.push(`💊 ${cap(noun)}: ${skipped} skipped`);
    } else {
      const skipNote = skipped > 0 ? ` · ${skipped} skipped` : "";
      const explain = mergedClause ? ` — ${mergedClause}` : "";
      yLines.push(
        `💊 ${cap(noun)}: ${taken}/${intended} taken${skipNote}${explain}`
      );
    }
  }
  if (input.weightKg != null) {
    // Rounded, kg per the notification unit policy documented on weightKg above.
    yLines.push(`⚖️ Weight: ${fmtWeight(input.weightKg, "kg")}`);
  }
  // Steps vs the declared target (#1723 part 2) — a verdict, not a raw number (#1712).
  if (input.stepsLine) yLines.push(`🚶 ${input.stepsLine}`);
  if (yLines.length) sections.push({ heading: "Yesterday", lines: yLines });

  // Sleep: a calm "how'd I sleep" (issue #1117) — last night's MAIN overnight
  // session vs baseline, stages when present, an SRI note, and any nap on its OWN
  // line (never folded into the overnight figure). Non-judgmental by design (#992):
  // it states the numbers, never "you slept badly".
  if (input.sleep) {
    const s = input.sleep;
    const sleepLines: string[] = [];
    const stages: string[] = [];
    if (s.deepMin != null && s.deepMin > 0)
      stages.push(`deep ${fmtSleepDuration(s.deepMin)}`);
    if (s.remMin != null && s.remMin > 0)
      stages.push(`REM ${fmtSleepDuration(s.remMin)}`);
    const stageNote = stages.length ? ` · ${stages.join(", ")}` : "";
    // STATE THE VERDICT, don't just print two numbers (#1712). The comparison the
    // reader was left to do is carried in words plus a direction marker, from the same
    // baseline the line already read. Below-baseline reads neutrally — the digest is
    // calm-tier, and #1292's poor-sleep acknowledgment owns that case. With no baseline
    // the line states the figure alone.
    const verdict = sleepVerdictPhrase(
      s.lastNightMin,
      s.baselineMin,
      fmtSleepDuration
    );
    // The verdict is a CLAUSE about the figure, so it takes the em-dash separator the
    // rest of the message uses for exactly that (#1819 item 7) — interpolated with a
    // bare space it read as one run-on quantity, "6h 38m about typical".
    sleepLines.push(
      `😴 Last night: ${fmtSleepDuration(s.lastNightMin)}${
        verdict ? ` — ${verdict}` : ""
      }${stageNote}`
    );
    // A same-day nap on its own line — kept apart from the overnight total.
    if (s.napMin != null && s.napMin > 0) {
      sleepLines.push(`💤 + ${fmtSleepDuration(s.napMin)} nap`);
    }
    if (s.sri != null) {
      // "Sleep regularity 94 — very consistent" (#1819 item 7). The old line paired an
      // acronym with a naked number ("Sleep regularity · SRI 94") and left the reader
      // to know the scale. The banded qualifier comes from the SAME sriPresentation
      // every SRI surface reads, and by #992's contract it qualifies the schedule's
      // consistency — never the sleeper.
      const sri = sriPresentation(s.sri);
      sleepLines.push(`📈 Sleep regularity ${sri.value} — ${sri.qualifier}`);
    }
    sections.push({ heading: "Sleep", lines: sleepLines });
  }

  // New since the last digest: things to look at.
  const newLines: string[] = [];
  for (const b of input.newFlaggedBiomarkers) {
    const val = b.value ? ` ${b.value}` : "";
    newLines.push(`🚩 ${b.name}${val} (${b.flag})`);
  }
  if (input.newDocumentLabels.length) {
    newLines.push(
      `📄 ${input.newDocumentLabels.length} new document${input.newDocumentLabels.length === 1 ? "" : "s"}: ${input.newDocumentLabels.join(", ")}`
    );
  }
  // The recent-changes lines (#1713) join the SAME section, below the flagged results
  // and new documents the digest's own send-cursor window already reported. That order
  // is the floor holding end to end: a flagged lab leads the section, the collector's
  // own flagged-vital floor leads what follows, and routine lines can never displace
  // either. The collector has already ranked, capped and appended any "+N more", so
  // nothing here can spill.
  for (const line of input.recentChangeLines ?? []) newLines.push(line);
  if (newLines.length) sections.push({ heading: "New", lines: newLines });

  // MINIMAL DIGEST GUARANTEE (#1505, owner-decided). Normally an empty digest is
  // suppressed — a hollow "nothing to report" is worse than silence. But when the
  // profile has `may` items on offer, the digest is ALSO the guaranteed access path
  // for them, and suppressing it would leave a tap-only user with no way to reach
  // their own list. So a tail-only message is legitimate: no sections, one button.
  // It is not a new send either — the digest already had permission to arrive today.
  if (sections.length === 0 && !input.offerTail) return null;
  // A tail-only digest still needs a body: an empty message reads as a bug. The
  // count rides the sentence here on EVERY channel — with no other content there is
  // nothing for the Telegram button to be redundant against, and a bare "Nothing
  // scheduled." beside a "Log other" button would under-describe what is on offer.
  if (sections.length === 0) {
    const offered = input.offerCount ?? 0;
    sections.push({
      heading: "Today",
      lines: [
        "✅ Nothing scheduled." +
          (offered > 0 ? ` ➕ ${offerTextTail(offered)}.` : ""),
      ],
    });
    return {
      title: `☀️ Morning digest — ${input.profileName}`,
      sections,
      offerTail: input.offerTail ?? null,
      // A tail-only digest has no category content, so there is nothing to tune.
      tuneTail: null,
    };
  }
  return {
    title: `☀️ Morning digest — ${input.profileName}`,
    sections,
    offerCount: input.offerCount ?? 0,
    offerTail: input.offerTail ?? null,
    tuneTail: input.tuneTail ?? null,
  };
}

// Render the model to a channel-agnostic NotificationMessage. The body lists each
// section's heading followed by its bulleted lines; the title (bolded by the
// Telegram renderer) already names the profile.
export function renderDigestMessage(model: DigestModel): NotificationMessage {
  const body = model.sections
    .map((s) => [s.heading, ...s.lines.map((l) => `• ${l}`)].join("\n"))
    .join("\n\n");
  // The offer tail's TEXT line goes ONLY to the channels that cannot render its
  // control (#1712). On Telegram the button IS the line — it names the slot and the
  // count — so a body line there duplicated the control beside it and, when the tail
  // was expanded, claimed "+3 available" while the keyboard already listed all three.
  const availableLine = offerTextTail(model.offerCount ?? 0);
  const textTailBody = availableLine
    ? joinBody([body, `➕ ${availableLine}`], "\n\n")
    : null;
  // Actions, in reach order: the guaranteed access tail first (#1505 — it is the one
  // affordance that is always correct to offer), then the collapsed ⚙️ Tune control
  // (#1714). Both are keyboard-only; a message with neither carries no buttons at all.
  const actions = [model.offerTail, model.tuneTail].filter(
    (a): a is NotificationAction => a != null
  );
  return {
    title: model.title,
    body,
    ...(textTailBody
      ? {
          bodyByChannel: {
            push: textTailBody,
            "home-assistant": textTailBody,
          },
        }
      : {}),
    kind: "digest",
    ...(actions.length ? { actions } : {}),
  };
}
