// Pure rendering + settings serialization for the Telegram household dose round
// (issue #1459). No DB, no network — the DB-touching gather is ./household-round.ts,
// which hands this module pre-gathered per-member lists. Unit-tested in
// lib/__tests__/household-round-format.test.ts.
//
// WHAT THIS IS. Household dose confirmation existed only as a DESTINATION: the
// Household page has per-member confirm buttons, but the dose moment happens at the
// breakfast table, and the Telegram reminder that reaches a caregiver there carries
// exactly ONE profile. This message is the moment-side twin — one slot message listing
// each selected member's due-unconfirmed doses, each with its own confirm button.
//
// SAFETY CLASS. The round carries `kind: "dose"` deliberately (the #924 precedent):
// it IS a scheduled dose reminder, so it inherits the dose kind's safety-tier routing
// and per-login delivery toggle rather than minting a parallel kind that would have to
// re-derive them. It is never bus-gated and never quiet-hours-gated (#449/#942).
//
// NOT AN AGGREGATOR. Missed-dose escalation is deliberately NOT folded in here — a
// critical signal must not be softened into a convenience digest (§4 of the issue).

import type { NotificationAction, NotificationMessage } from "./types";
import type { AppRoute } from "../hrefs";
import { householdDoseCallback } from "./callback-data";

// One member's due-unconfirmed doses for the round. `name` arrives ALREADY
// disambiguated (#534) — the builder resolves two "Alex"es to stable labels before
// formatting, because a confirm button that can't tell two members apart is worse
// than no button.
export interface HouseholdRoundDose {
  doseId: number;
  itemId: number;
  itemName: string;
  // The dose amount label ("2000 IU", "500 mg"), or null when the item stores none.
  amount: string | null;
}

export interface HouseholdRoundSection {
  profileId: number;
  name: string;
  // The member's OWN profile-local day (#1095: per-profile context stays
  // per-profile-composed). A round assembled at the receiver's slot can legitimately
  // span two calendar dates when a member lives in another timezone, so the date is
  // per SECTION and is what each of that member's confirm tokens carries — never the
  // receiver's day, which would log the dose against the wrong date for that member.
  date: string;
  doses: HouseholdRoundDose[];
}

// Keyboard cap for one round. Telegram's own ceiling is 100 buttons, but a wall of
// confirm taps is not a usable breakfast-table surface — past this many due doses the
// round drops its buttons entirely and offers the Household page instead, which is the
// better tool for a large round. Kept well under the transport cap on purpose.
export const HOUSEHOLD_ROUND_MAX_BUTTONS = 12;

// "Vitamin D3 · 2000 IU", or just the name when no amount is stored.
export function householdDoseLabel(dose: HouseholdRoundDose): string {
  const amount = dose.amount?.trim();
  return amount ? `${dose.itemName} · ${amount}` : dose.itemName;
}

// Total doses across every section — the cap is measured on the whole round, since
// the keyboard is one keyboard.
export function householdRoundDoseCount(
  sections: readonly HouseholdRoundSection[]
): number {
  return sections.reduce((n, s) => n + s.doses.length, 0);
}

// The round message, or null when there is nothing to send. An EMPTY ROUND SENDS
// NOTHING (§2): a member with nothing due is omitted, and a round where every member
// is omitted produces no message at all — a caregiver must never be pinged to be told
// there is nothing to do.
//
// `receiverProfileId` is the SUBSCRIBING profile (whose chat this lands in); it is
// baked into every callback token so a tap can be cross-checked against the chat that
// received it. `base` is the public app URL for the overflow deep link ("" when none
// is configured — the overflow then simply carries no button).
export function renderHouseholdRoundMessage(input: {
  receiverProfileId: number;
  sections: readonly HouseholdRoundSection[];
  base: string;
  householdHref: AppRoute;
}): NotificationMessage | null {
  const sections = input.sections.filter((s) => s.doses.length > 0);
  if (sections.length === 0) return null;

  const body = sections
    .map((s) =>
      [`${s.name}:`, ...s.doses.map((d) => `• ${householdDoseLabel(d)}`)].join(
        "\n"
      )
    )
    .join("\n\n");

  const total = householdRoundDoseCount(sections);
  const memberNoun = sections.length === 1 ? "member" : "members";
  const title = `💊 Household doses — ${total} due across ${sections.length} ${memberNoun}`;

  // Under the cap the round carries its confirm buttons — and, since #1718, the deep
  // link ALONGSIDE them. Web Push and Home Assistant strip the buttons, so those
  // copies used to arrive naming members and items with no way to confirm or even
  // open the page; the over-cap path already degraded to exactly this link. A
  // url-bearing action also becomes the push notification's click-through target
  // (pushClickThroughUrl), so the push finally opens where it should.
  const actions =
    total > HOUSEHOLD_ROUND_MAX_BUTTONS
      ? overflowActions(input.base, input.householdHref)
      : [
          ...confirmActions(input.receiverProfileId, sections),
          ...overflowActions(input.base, input.householdHref),
        ];

  return {
    title,
    body,
    ...(actions.length > 0 ? { actions } : {}),
    kind: "dose",
  };
}

// Per-dose confirm buttons, grouped one row per MEMBER (`row` keys by profile id, so
// consecutive doses for the same member share a row). Each label names the member as
// well as the item — the button is the only thing a tapping thumb reads, and a bare
// "✓ Vitamin D3" in a two-child round is exactly the #531 label collision.
function confirmActions(
  receiverProfileId: number,
  sections: readonly HouseholdRoundSection[]
): NotificationAction[] {
  const actions: NotificationAction[] = [];
  for (const section of sections) {
    for (const dose of section.doses) {
      actions.push({
        label: `✓ ${section.name} · ${householdDoseLabel(dose)}`,
        data: householdDoseCallback({
          receiverProfileId,
          memberProfileId: section.profileId,
          doseId: dose.doseId,
          itemId: dose.itemId,
          date: section.date,
        }),
        row: `hh:${section.profileId}`,
      });
    }
  }
  return actions;
}

// Past the cap the round degrades to a deep link rather than a wall of buttons — the
// two-way principle's own escape hatch (a button is earned only where the response is
// ONE low-risk state change; twelve-plus taps is a page, not a message).
function overflowActions(
  base: string,
  householdHref: AppRoute
): NotificationAction[] {
  if (!base) return [];
  return [{ label: "Open Household →", url: `${base}${householdHref}` }];
}

// ---- Stored member selection (profile_settings) ----------------------------------
//
// The selection is DATA, NOT AN AUTH CHECK (the ProfileScope stance): it records what
// the caregiver picked, and every read re-validates each id against live grants at send
// time and again at tap time. So parsing is deliberately permissive about content and
// strict about SHAPE — a malformed value degrades to "nothing selected", never to a
// throw on the notify tick.

export function parseHouseholdRoundMembers(raw: string | undefined): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = new Set<number>();
  for (const value of parsed) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

export function serializeHouseholdRoundMembers(ids: readonly number[]): string {
  return JSON.stringify(parseHouseholdRoundMembers(JSON.stringify(ids)));
}
