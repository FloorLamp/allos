// Per-profile morning digest — PURE assembly + rendering, no
// DB/network, so both are unit-tested in lib/__tests__. The DB gather lives in
// ./digest-data. buildDigest turns the gathered facts into a section/line model,
// collapsing empty sections and returning null when there's nothing worth sending;
// renderDigestMessage turns that model into the Telegram message (kept separate
// from assembly per the issue). The title always names the profile — a chat may be
// shared by several profiles (the chat-id ambiguity fix).

import type { NotificationMessage } from "./types";
import type { ActivityType, SupplementKind } from "../types";
import { fmtWeight, fmtDistance } from "../units";
import { intakeWindowNoun, intakeItemNoun } from "./supplement-format";
import { situationActivationLine } from "../situations";

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

export interface DigestGoalDue {
  label: string;
  count: number;
  perWeek: number;
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
  goalsDue: DigestGoalDue[]; // frequency targets not yet met this week
  // Count of situational intake items due TODAY because their situation is active
  // (issue #662 item 1) — the optional digest mention of the same "N situational
  // items now active" the situations bar shows. Optional/0 ⇒ the line is omitted.
  situationalActiveCount?: number;
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
}

export interface DigestSection {
  heading: string;
  lines: string[];
}

export interface DigestModel {
  title: string;
  sections: DigestSection[];
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

  // Today: what's on deck.
  const todayLines: string[] = [];
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
  for (const g of input.goalsDue) {
    todayLines.push(`🎯 ${g.label}: ${g.count}/${g.perWeek} this week`);
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
