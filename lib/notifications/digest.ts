// Per-profile morning digest — PURE assembly + rendering, no
// DB/network, so both are unit-tested in lib/__tests__. The DB gather lives in
// ./digest-data. buildDigest turns the gathered facts into a section/line model,
// collapsing empty sections and returning null when there's nothing worth sending;
// renderDigestMessage turns that model into the Telegram message (kept separate
// from assembly per the issue). The title always names the profile — a chat may be
// shared by several profiles (the chat-id ambiguity fix).

import type { NotificationMessage } from "./types";
import type { ActivityType, SupplementKind } from "../types";
import type { BandGroup, UpcomingDomain } from "../upcoming";
import { fmtWeight, fmtDistance } from "../units";
import { intakeWindowNoun, intakeItemNoun } from "./supplement-format";
import { situationActivationLine } from "../situations";
import { heldSummaryLine } from "../supplement-schedule";
import { buildUpcomingDigest } from "./upcoming-digest";
import { sriPresentation } from "../sleep-regularity";

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
  // Yesterday
  activities: DigestActivity[];
  // Supplement adherence yesterday, or null when nothing was due. `skipped`
  // counts deliberate skips (#232), surfaced alongside taken.
  adherence: { taken: number; skipped: number; due: number } | null;
  // Weight logged yesterday, canonical kg. Rendered in kg by policy: the
  // notification has no login-unit context (multiple logins, each with its own
  // weight preference, can watch one profile), so all notification builders emit
  // canonical kg — the same policy the weekly recap documents. Rounded via the
  // shared fmtWeight formatter rather than printed as the raw stored float (#380).
  weightKg: number | null;
  // New since the last digest
  newFlaggedBiomarkers: DigestFlaggedBiomarker[];
  newDocumentLabels: string[];
  // Last night's sleep (issue #1117), or null when the sleep summary is off or
  // there's no fresh sleep data. When present the digest gets a calm Sleep section.
  sleep?: DigestSleep | null;
}

export interface DigestSection {
  heading: string;
  lines: string[];
}

export interface DigestModel {
  title: string;
  sections: DigestSection[];
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
  // The banded "what's due" summary + high-priority "why" lines, from the SAME
  // collectUpcoming formatter the Upcoming page/hero read. Doses are EXCLUDED from
  // the per-band counts (the glance line above already summarizes them) so a day of
  // only doses reads as one clean line, not "💊 3 doses" + "Today: 3 doses".
  const due = buildUpcomingDigest(input.profileName, input.todayGroups, {
    excludeDomains: DOSE_EXCLUDED_FROM_BANDS,
  });
  if (due) {
    for (const line of due.lines) todayLines.push(line);
    for (const h of due.highlights) {
      todayLines.push(`⚑ ${h.title} — ${h.reason}`);
    }
  }
  if (todayLines.length) sections.push({ heading: "Today", lines: todayLines });

  // Yesterday: what happened.
  const yLines: string[] = [];
  for (const a of input.activities) {
    yLines.push(`🏋️ ${a.title}${activityStat(a)}`);
  }
  if (input.adherence) {
    // Skips are excluded from the "of N due" figure (they weren't intended
    // doses); a nonzero skip count is shown as a trailing note (#232).
    const { taken, skipped, due } = input.adherence;
    const intended = due - skipped;
    if (intended <= 0) {
      // Everything due was deliberately skipped — a "0/0 taken" line reads as a
      // bug (#380 nit); state the skips plainly instead.
      yLines.push(`💊 ${cap(noun)}: ${skipped} skipped`);
    } else {
      const skipNote = skipped > 0 ? ` · ${skipped} skipped` : "";
      yLines.push(`💊 ${cap(noun)}: ${taken}/${intended} taken${skipNote}`);
    }
  }
  if (input.weightKg != null) {
    // Rounded, kg per the notification unit policy documented on weightKg above.
    yLines.push(`⚖️ Weight: ${fmtWeight(input.weightKg, "kg")}`);
  }
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
    sleepLines.push(
      `😴 Last night: ${fmtSleepDuration(s.lastNightMin)} (typical ~${fmtSleepDuration(
        s.baselineMin
      )})${stageNote}`
    );
    // A same-day nap on its own line — kept apart from the overnight total.
    if (s.napMin != null && s.napMin > 0) {
      sleepLines.push(`💤 + ${fmtSleepDuration(s.napMin)} nap`);
    }
    if (s.sri != null) {
      sleepLines.push(`📈 Sleep regularity · ${sriPresentation(s.sri).text}`);
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
  if (newLines.length) sections.push({ heading: "New", lines: newLines });

  if (sections.length === 0) return null;
  return {
    title: `☀️ Morning digest — ${input.profileName}`,
    sections,
  };
}

// Render the model to a channel-agnostic NotificationMessage. The body lists each
// section's heading followed by its bulleted lines; the title (bolded by the
// Telegram renderer) already names the profile.
export function renderDigestMessage(model: DigestModel): NotificationMessage {
  const body = model.sections
    .map((s) => [s.heading, ...s.lines.map((l) => `• ${l}`)].join("\n"))
    .join("\n\n");
  return { title: model.title, body, kind: "digest" };
}
