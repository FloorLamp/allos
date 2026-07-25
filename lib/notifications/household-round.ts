// The DB-touching gather for the Telegram household dose round (issue #1459). The
// pure message rendering is ./household-round-format; the access rule is
// ./household-round-access. Split so the formatter is pure-tier testable and this
// builder gets its own #448 fixture test — every confirmed rule-engine defect in this
// codebase has lived in a builder's INPUT layer, which the pure tier structurally
// cannot see.
//
// PER-PROFILE CONTEXT STAYS PER-PROFILE-COMPOSED (#1095). This is a cross-profile
// READER, so it takes already-resolved ids and never imports lib/auth's session
// helpers — but it is emphatically NOT a `profile_id IN (…)` reader: every member's
// due set depends on that member's own `today()`/timezone, their situations, their
// workout-conditioned dueness and their PRN exclusion. So the gather LOOPS, calling
// the same per-profile `collectWindowDoses` the member's own reminder uses. Nothing
// here is ever evaluated in the receiver's context.
//
// ONE QUESTION, ONE COMPUTATION. The member's due set comes from `collectWindowDoses`
// + the #1156 priority floor — byte for byte the gather that builds that member's OWN
// dose reminder — so the round and the member's reminder can never disagree about
// what is due. This module adds no dueness logic of its own.

import { today } from "../db";
import { getPublicUrl, getProfileHouseholdRound } from "../settings";
import { disambiguateProfileNames } from "../profile-disambiguation";
import { collectWindowDoses } from "./supplements";
import {
  notifiableWindowDoses,
  type IntakeSendSlot,
} from "./supplement-format";
import { householdRoundMembers } from "./household-round-access";
import {
  renderHouseholdRoundMessage,
  type HouseholdRoundSection,
} from "./household-round-format";
import type { NotificationMessage } from "./types";

// The Household page — the destination this round reaches from, and the overflow
// deep-link target. A plain literal rather than an AppRoute import: this module is
// consumed by the notify tick (a plain tsx script), and the value is pinned by the
// pure format test alongside every other piece of the message.
const HOUSEHOLD_PATH = "/household";

// The per-day dedupe marker for a receiver's round in one slot. Keyed on the
// RECEIVER's profile + slot, exactly like `notify_last_supp_<slot>`, and stored on
// the receiver's profile_settings: the round is the receiver's notification, so the
// receiver owns its marker (the members' own markers are untouched — a member still
// gets their own reminder and their own escalation, #1459 §2 "additive").
export function householdRoundMarkerKey(slot: IntakeSendSlot): string {
  return `notify_last_household_${slot}`;
}

// One member's due-unconfirmed doses for `slots`, gathered in THAT member's own
// context and day. Returns null when the member has nothing due — the caller omits
// the section entirely (§2: members with nothing due are omitted).
function sectionFor(
  memberProfileId: number,
  name: string,
  slots: readonly IntakeSendSlot[]
): HouseholdRoundSection | null {
  // The member's OWN day — the two-timezone case the DB-tier fixture pins.
  const date = today(memberProfileId);
  const seen = new Set<number>();
  const doses: HouseholdRoundSection["doses"] = [];
  for (const slot of slots) {
    // The #1156 priority floor applies at send assembly, the same as the member's own
    // reminder. PRN items never appear: they are not scheduled-due, so `isDueOn`
    // inside the gather excludes them (a PRN med has no dose to confirm on a clock).
    for (const entry of notifiableWindowDoses(
      collectWindowDoses(memberProfileId, slot, date)
    )) {
      // Already resolved — taken OR deliberately skipped (#232) — is not "due".
      if (entry.taken || entry.skipped) continue;
      if (seen.has(entry.dose.id)) continue; // a slot merge can revisit a dose
      seen.add(entry.dose.id);
      doses.push({
        doseId: entry.dose.id,
        itemId: entry.supp.id,
        itemName: entry.supp.name,
        amount: entry.dose.amount,
      });
    }
  }
  if (doses.length === 0) return null;
  return { profileId: memberProfileId, name, date, doses };
}

// The round's sections for `receiverProfileId` at `slots` — the §1-validated member
// set, each gathered in its own context, empty members dropped. Exported for the
// DB-tier fixture test and the settings send-test; the send path uses
// buildHouseholdRound below.
export function collectHouseholdRound(
  receiverProfileId: number,
  slots: readonly IntakeSendSlot[]
): HouseholdRoundSection[] {
  const { enabled, memberIds } = getProfileHouseholdRound(receiverProfileId);
  if (!enabled || memberIds.length === 0 || slots.length === 0) return [];
  // Live grants are the authority; the stored selection only narrows them.
  const members = householdRoundMembers(receiverProfileId, memberIds);
  if (members.length === 0) return [];
  // Disambiguated names (#534) — two "Alex"es in one round would otherwise mint two
  // identical confirm buttons, which is the label collision at its most dangerous.
  const labels = disambiguateProfileNames(
    members.map((m) => ({ id: m.profileId, name: m.name }))
  );
  const sections: HouseholdRoundSection[] = [];
  for (const member of members) {
    const section = sectionFor(
      member.profileId,
      labels.get(member.profileId) ?? member.name,
      slots
    );
    if (section) sections.push(section);
  }
  return sections;
}

// The round message for `receiverProfileId` at `slots`, or null when nothing is due
// (an empty round sends nothing). `slots` are the RECEIVER's slots that fired this
// hour — the round rides the existing tick and the receiver's own schedule.
export function buildHouseholdRound(
  receiverProfileId: number,
  slots: readonly IntakeSendSlot[]
): NotificationMessage | null {
  const sections = collectHouseholdRound(receiverProfileId, slots);
  return renderHouseholdRoundMessage({
    receiverProfileId,
    sections,
    base: getPublicUrl(),
    householdHref: HOUSEHOLD_PATH,
  });
}

// The member's display label as the ROUND renders it — the disambiguated name (#534),
// resolved from the same selected-member set the send used, so a confirm toast names
// the person exactly as the button that produced it did. Falls back to the raw profile
// name (then a bare id) when the member is no longer offerable, since a refusal toast
// still has to name someone.
export function householdMemberLabel(
  receiverProfileId: number,
  memberProfileId: number
): string {
  const { memberIds } = getProfileHouseholdRound(receiverProfileId);
  const members = householdRoundMembers(receiverProfileId, memberIds);
  const labels = disambiguateProfileNames(
    members.map((m) => ({ id: m.profileId, name: m.name }))
  );
  return (
    labels.get(memberProfileId) ??
    members.find((m) => m.profileId === memberProfileId)?.name ??
    `Profile ${memberProfileId}`
  );
}
