import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_KIND_REGISTRY,
  SAFETY_NOTIFICATION_KINDS,
  isSafetyKind,
  notificationKindEntry,
  slotRequirementNote,
  unmetSlotRequirement,
} from "../notifications/kinds";

// WHAT IS LEFT HERE, AND WHY (#5351).
//
// This file used to reconcile the kind registry against the `NotificationKind` union
// on every run: every kind accounted for, no stale row, no duplicate, no safety kind
// carrying a settings enable, plus a source scan over the `kind: "…"` literals in
// lib/notifications. All of it is now `tsc`. `NOTIFICATION_KINDS` is keyed on the
// union, so a missing, retired or duplicated kind does not compile and a safety
// kind's row cannot be spelled with a per-kind control; `NotificationMessage.kind` is
// that same union, so a dispatched kind outside it never compiled either. A guard
// that lists a union's members does not track the union
// (docs/internals/verification-failure-modes.md line 83).
//
// What stays is what neither a type nor ESLint can see: a COPY rule over prose, a
// uniqueness fact across row VALUES, one policy set, and the behaviour of two pure
// functions.

describe("registry copy and cross-row facts", () => {
  it("every row's blurb is one sentence", () => {
    // The copy standard (#945): helper text under a control is ONE sentence; anything
    // longer belongs in `more`, behind the row's disclosure. Prose, so no type sees it.
    for (const e of NOTIFICATION_KIND_REGISTRY) {
      expect(e.label.length).toBeGreaterThan(2);
      const sentences = e.blurb.match(/[.?!]/g)?.length ?? 0;
      expect(sentences, `blurb for ${e.kind}: ${e.blurb}`).toBe(1);
    }
  });

  it("no two rows write the same saveNotificationPrefs field", () => {
    // A uniqueness fact over the VALUES of a string field, across rows. The type says
    // each control names a field; it cannot say the names differ, and two kinds
    // sharing one setting would silently make one row the other's remote control.
    const fields: string[] = [];
    for (const e of NOTIFICATION_KIND_REGISTRY) {
      if (e.control.type === "toggle" || e.control.type === "time")
        fields.push(e.control.field);
      if (e.control.type === "day-time")
        fields.push(e.control.dayField, e.control.timeField);
      for (const x of e.extras ?? []) fields.push(x.field);
    }
    expect(new Set(fields).size, fields.join(", ")).toBe(fields.length);
  });

  it("notificationKindEntry answers for a row and not for an inert kind", () => {
    expect(notificationKindEntry("digest")?.label).toBe("Morning digest");
    expect(notificationKindEntry("test")).toBeUndefined();
  });

  it("keeps exactly the historical safety set (#928)", () => {
    // A POLICY set, not a shape: the type states that these three carry no per-kind
    // enable, never that the set has these three members. Widening it moves what may
    // never be silently suppressed, which is a decision rather than a refactor.
    expect([...SAFETY_NOTIFICATION_KINDS].sort()).toEqual([
      "dose",
      "escalation",
      "redose",
    ]);
    expect(isSafetyKind("refill")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The slot-precondition declaration (#2161 review).
//
// A kind with NO schedule of its own fires at an intake reminder slot minute. Those
// slots are independently switchable, so "every slot this kind rides is off" is a
// reachable state in which the kind's own checkbox reads ON and nothing is ever sent.
// Silence with an enabled-looking control is the worst failure a settings page has,
// and it is worse still for a CONSENT — the whole point of the bedtime wear reminder
// is that the user asked for it.
//
// The fix is a declaration plus a rendered note, never a fallback hour: guessing a
// bedtime for a send the user consented to at THEIR bedtime is a worse answer than
// naming the missing precondition out loud.
describe("slot preconditions (#2161)", () => {
  const byKind = new Map(NOTIFICATION_KIND_REGISTRY.map((e) => [e.kind, e]));

  it("declares the slots for every kind whose whole schedule is a slot minute", () => {
    // "This kind's only schedule is a slot" is not a shape a type can hold, so a NEW
    // slot-riding kind has to be decided about here rather than silently inheriting
    // "no precondition".
    const declared = Object.fromEntries(
      NOTIFICATION_KIND_REGISTRY.filter((e) => e.ridesSlots).map((e) => [
        e.kind,
        e.ridesSlots,
      ])
    );
    expect(declared).toEqual({
      // FOOD_NUDGE_WINDOWS — Bedtime is deliberately not one of them.
      food: ["Morning", "Midday", "Evening"],
      mood: ["Evening"],
      "wear-reminder": ["Bedtime"],
    });
  });

  it("is unmet only when EVERY declared slot is off", () => {
    const wear = byKind.get("wear-reminder")!;
    expect(unmetSlotRequirement(wear, () => true)).toBeNull();
    expect(unmetSlotRequirement(wear, () => false)).toEqual(["Bedtime"]);
    // One of several is enough — the food nudge rides whichever windows are set.
    const food = byKind.get("food")!;
    expect(unmetSlotRequirement(food, (s) => s === "Midday")).toBeNull();
    expect(unmetSlotRequirement(food, () => false)).toEqual([
      "Morning",
      "Midday",
      "Evening",
    ]);
  });

  it("says nothing about a kind that owns its own schedule", () => {
    // The digest and the recap carry their own time controls; a milestone has no
    // schedule at all. None of them can be silenced by a slot, so none declares one
    // and none may grow a note.
    for (const kind of ["digest", "weekly-recap", "milestone", "dose"] as const)
      expect(unmetSlotRequirement(byKind.get(kind)!, () => false)).toBeNull();
  });

  it("names the missing slots in the note, and points at the Schedule card", () => {
    expect(slotRequirementNote(["Bedtime"])).toContain("your Bedtime reminder");
    expect(slotRequirementNote(["Bedtime"])).toContain("Schedule");
    expect(slotRequirementNote(["Morning", "Midday", "Evening"])).toContain(
      "Morning, Midday, or Evening"
    );
  });
});
