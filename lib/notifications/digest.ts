// Per-profile morning digest (issue #135) — PURE assembly + rendering, no
// DB/network, so both are unit-tested in lib/__tests__. The DB gather lives in
// ./digest-data. buildDigest turns the gathered facts into a section/line model,
// collapsing empty sections and returning null when there's nothing worth sending;
// renderDigestMessage turns that model into the Telegram message (kept separate
// from assembly per the issue). The title always names the profile — a chat may be
// shared by several profiles (#135's chat-id ambiguity fix).

import type { NotificationMessage } from "./types";

export interface DigestActivity {
  title: string;
  type: "strength" | "cardio" | "sport";
  durationMin: number | null;
  distanceKm: number | null;
}

export interface DigestGoalDue {
  label: string;
  count: number;
  perWeek: number;
}

export interface DigestFlaggedBiomarker {
  name: string;
  value: string | null;
  flag: string;
}

export interface DigestInput {
  profileName: string;
  // Today
  doseCount: number; // supplement/medication doses scheduled today
  goalsDue: DigestGoalDue[]; // frequency targets not yet met this week
  // Yesterday
  activities: DigestActivity[];
  adherence: { taken: number; due: number } | null; // null when nothing was due
  weightKg: number | null; // weight logged yesterday (canonical kg)
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
    return ` — ${a.distanceKm} km`;
  }
  if (a.durationMin != null) return ` — ${a.durationMin} min`;
  return "";
}

// Assemble the digest model, or null when every section is empty (so the tick
// sends nothing rather than a hollow "nothing to report").
export function buildDigest(input: DigestInput): DigestModel | null {
  const sections: DigestSection[] = [];

  // Today: what's on deck.
  const todayLines: string[] = [];
  if (input.doseCount > 0) {
    todayLines.push(
      `💊 ${input.doseCount} supplement dose${input.doseCount === 1 ? "" : "s"} scheduled`
    );
  }
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
    yLines.push(
      `💊 Supplements: ${input.adherence.taken}/${input.adherence.due} taken`
    );
  }
  if (input.weightKg != null) {
    yLines.push(`⚖️ Weight: ${input.weightKg} kg`);
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
  return { title: model.title, body };
}
