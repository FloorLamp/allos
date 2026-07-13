// Pure rendering for the preventive-care nudge — kept DB-free so it's unit-tested
// (lib/__tests__), mirroring supplement-format.ts. The DB gather + send loop lives
// in ./preventive.
//
// One message PER screening: each nudge names its screening in the title and
// carries exactly one ✅ Done / 🚫 Not applicable / ⏰ Remind later row, so the
// buttons are unambiguously attached to the named item (the supplement reminder's
// per-dose "✅ {name}" discipline, applied at message granularity — with several
// screenings in one message the identical unlabeled rows couldn't be told apart).
// The dedup stays per rule (once per due episode), so splitting the message does
// not change how often anything fires.

import type { PreventiveNudgeItem } from "../preventive-nudge";
import type { NotificationMessage } from "./types";

// Render ONE screening's nudge. Names the profile (a shared/caregiver chat may
// carry several profiles) and the screening. The three buttons (issue #233) map
// 1:1 onto the SAME functions the Upcoming page uses — ✅ Done →
// recordPreventiveDone, 🚫 Not applicable → setPreventiveOverride, ⏰ Remind
// later → findings-bus snooze (#227) — one row keyed by the rule's stable catalog
// key (never a name; the key is the token payload and the row key).
export function renderPreventiveMessage(
  profileName: string,
  item: PreventiveNudgeItem,
  profileId: number
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const tag = item.status === "overdue" ? "Overdue" : "Due";
  const extra = item.detail ? ` — ${item.detail}` : "";
  const row = `pv:${item.ruleKey}`;
  return {
    title: `🩺 Preventive care: ${who}${item.name}`,
    body: `${item.name}: ${tag}${extra}\n\nInformational only — not medical advice.`,
    actions: [
      { label: "✅ Done", data: `pvdone:${profileId}:${item.ruleKey}`, row },
      {
        label: "🚫 Not applicable",
        data: `pvna:${profileId}:${item.ruleKey}`,
        row,
      },
      {
        label: "⏰ Remind later",
        data: `pvlater:${profileId}:${item.ruleKey}`,
        row,
      },
    ],
    kind: "preventive",
  };
}
