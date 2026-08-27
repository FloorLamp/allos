import { describe, expect, it } from "vitest";
import {
  attachUsualRoutine,
  usualDispatchProblem,
  usualRoutineAttachmentFor,
  usualTokenOn,
  USUAL_ROW,
} from "@/lib/notifications/usual-routine-attach";
import { dispatchableUsual } from "@/lib/notifications/usual-routine-plan";
import {
  offerCallback,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from "@/lib/notifications/callback-data";
import { usualRoutinePhrase } from "@/lib/usual-routine";
import { plainBody } from "@/lib/notifications/rich-text";
import type { NotificationMessage } from "@/lib/notifications/types";

// THE COMPOSED ONE-TAP AS A THING A MESSAGE CARRIES (#2460). Pure: what the attachment
// SAYS, where it sits, and the two ways a message carrying it is unfit to send.

const OFFER = {
  window: "Morning" as const,
  groups: ["fermented", "berries"],
  doses: [
    { doseId: 1, itemId: 1, name: "Creatine", detail: null },
    { doseId: 8, itemId: 8, name: "Collagen", detail: null },
    { doseId: 10, itemId: 10, name: "B-complex", detail: null },
  ],
};
const TOKEN = offerCallback("usual", 4, 77);

function host(): NotificationMessage {
  return {
    title: "Morning doses",
    body: "Two doses pending.",
    actions: [
      { label: "All (2)", data: "all:4:Morning:2026-08-19" },
      { label: "Creatine", data: "take:4:1:1:2026-08-19", row: "dose:1" },
    ],
    kind: "dose",
  };
}

// Every attachment below is built from a token that fits — the cliff itself is the last
// describe in this file. Throws rather than `!` so a token that stopped fitting names
// itself instead of surfacing as a null-deref three assertions later.
function attachment(offer = OFFER, token = TOKEN) {
  const a = usualRoutineAttachmentFor(offer, token);
  if (!a) throw new Error(`token did not fit the callback budget: ${token}`);
  return a;
}

describe("what the composed one-tap promises (#2460)", () => {
  it("the line names the FULL composed set, in the shared phrase", () => {
    const a = attachment(OFFER, TOKEN);
    // The same function the dashboard control and its accessible name use, so no
    // surface can promise this write in different words.
    expect(a.line).toContain(
      usualRoutinePhrase(["Fermented foods", "Berries"], OFFER.doses)
    );
    // Every named thing is actually in it — a line that dropped a half would be an
    // offer naming less than the tap would write.
    for (const name of ["Fermented foods", "Berries", "Creatine", "Collagen"]) {
      expect(a.line).toContain(name);
    }
  });

  it("the button's count is every write the tap performs, both halves", () => {
    const a = attachment(OFFER, TOKEN);
    expect(a.label).toContain("(5)"); // 2 groups + 3 doses
    expect(a.label).toContain("Morning");
  });

  it("the count follows the offer, not the food half alone", () => {
    // Falsifies "the label counts groups": the same groups with no doses reads (2).
    const foodOnly = attachment({ ...OFFER, doses: [] }, TOKEN);
    expect(foodOnly.label).toContain("(2)");
    expect(foodOnly.line).not.toContain("Creatine");
  });
});

describe("attaching the bundle to a message that is already sending", () => {
  it("adds the line below the host's body and the button at the head of the keyboard", () => {
    const a = attachment(OFFER, TOKEN);
    const out = attachUsualRoutine(host(), a);
    // The host's own words are kept and the promise sits under them.
    expect(plainBody(out.body)).toBe(`Two doses pending.\n${a.line}`);
    // FIRST: the bundle is the one-tap upgrade of the rows beneath it.
    expect(out.actions?.[0]).toEqual({
      label: a.label,
      data: TOKEN,
      row: USUAL_ROW,
    });
    // …and it takes nothing away: every host button survives, in order.
    expect(out.actions?.slice(1)).toEqual(host().actions);
  });

  it("attaching TWICE replaces the button and does not repeat the promise", () => {
    // The sweep attaches before it plans (so its keyboard comparison is honest) and the
    // send chokepoint attaches again downstream. That has to be a no-op, or the message
    // would promise the same write twice and carry two tokens for one offer.
    const a = attachment(OFFER, TOKEN);
    const once = attachUsualRoutine(host(), a);
    expect(attachUsualRoutine(once, a)).toEqual(once);
    // …and a REFRESHED attachment for the same offer replaces the stale button rather
    // than sitting beside it — which is how a reduced bundle re-renders.
    const reduced = attachment({ ...OFFER, doses: [] }, TOKEN);
    const again = attachUsualRoutine(once, reduced);
    expect(again.actions?.filter((x) => x.data === TOKEN)).toHaveLength(1);
    expect(again.actions?.[0]?.label).toBe(reduced.label);
    expect(plainBody(again.body)).toBe(plainBody(once.body));
  });

  it("a null attachment leaves the message EXACTLY as it was", () => {
    // The no-offer path is the common one, and it must not be a rewrite.
    expect(attachUsualRoutine(host(), null)).toEqual(host());
  });

  it("does not mutate the message it was handed", () => {
    const original = host();
    attachUsualRoutine(original, attachment(OFFER, TOKEN));
    expect(original.actions).toHaveLength(2);
    expect(plainBody(original.body)).toBe("Two doses pending.");
  });

  it("finds its own token back off a delivered keyboard, and nothing else's", () => {
    expect(
      usualTokenOn([
        [{ callback_data: "all:4:Morning:2026-08-19" }],
        [{ callback_data: TOKEN }],
      ])
    ).toBe(TOKEN);
    expect(
      usualTokenOn([[{ callback_data: "stacktake:4:2026-08-19:1,8" }]])
    ).toBeNull();
    expect(usualTokenOn([])).toBeNull();
  });
});

// THE ASSERTION BEFORE DISPATCH. Both problems are silent in production and expensive:
// two tokens means the second tap redeems a bundle the first already spent, and a
// keyboard with nothing to inherit from is owned by no sweep and never dies.
describe("a message carrying the bundle is checked before it is sent", () => {
  it("passes the ordinary case — one token, on a keyboard with a family", () => {
    const out = attachUsualRoutine(host(), attachment(OFFER, TOKEN));
    expect(usualDispatchProblem(out)).toBeNull();
    expect(dispatchableUsual(out)).toEqual(out);
  });

  it("refuses TWO composed one-taps on one message", () => {
    // Hand-assembled, because `attachUsualRoutine` can no longer produce this state —
    // the guard is against a message assembled some other way, and it is the state
    // where a second tap redeems a bundle the first already spent.
    const base = host();
    const twice: NotificationMessage = {
      ...base,
      actions: [
        { label: "Usual A", data: TOKEN, row: USUAL_ROW },
        { label: "Usual B", data: offerCallback("usual", 4, 78), row: USUAL_ROW },
        ...(base.actions ?? []),
      ],
    };
    expect(usualDispatchProblem(twice)).toContain("2");
    // The message still goes out — a dose reminder is safety tier — with the
    // decoration dropped and every host button intact.
    const fixed = dispatchableUsual(twice);
    expect(fixed.actions).toEqual(host().actions);
    expect(usualDispatchProblem(fixed)).toBeNull();
  });

  it("refuses a keyboard of ONLY host-inherited tokens", () => {
    // `usual:` elects no family, so this keyboard is owned by nothing and would sit in
    // the chat forever. It is invalid, not merely unowned.
    const orphan = attachUsualRoutine(
      { title: "Morning", body: "", actions: [], kind: "food" },
      attachment(OFFER, TOKEN)
    );
    expect(usualDispatchProblem(orphan)).toContain("inherit");
    expect(dispatchableUsual(orphan).actions).toEqual([]);
  });

  it("says nothing about a message that carries no bundle at all", () => {
    expect(usualDispatchProblem(host())).toBeNull();
    // …including one with no keyboard, which is most messages.
    expect(
      usualDispatchProblem({ title: "x", body: "y", kind: "digest" })
    ).toBeNull();
  });
});

// ── THE BYTE CLIFF, IN BOTH DIRECTIONS, AT THE BUTTON (#2460) ───────────────
//
// callback-data.test.ts pins the PREDICATE at the exact boundary. These pin the thing
// the owner's ruling is actually about: what a token one byte too long does to the
// BUTTON. Not a smaller offer, not a truncated set — no button, and no line either,
// because the line promises the write the button performs.
//
// Deleting `if (!callbackDataFits(token)) return null;` leaves every other test in this
// repo green. These are its only witnesses.
describe("a token that does not fit removes the whole button (#2460)", () => {
  // Real tokens are `usual:<profileId>:<offerId>` and constant-size, so these are built
  // to the boundary directly: the check must hold for any shape the token ever takes.
  const atLimit = `usual:4:${"7".repeat(TELEGRAM_CALLBACK_DATA_MAX_BYTES - 8)}`;
  const oneOver = `${atLimit}7`;

  it("the fixtures sit exactly on the boundary", () => {
    expect(new TextEncoder().encode(atLimit).length).toBe(
      TELEGRAM_CALLBACK_DATA_MAX_BYTES
    );
    expect(new TextEncoder().encode(oneOver).length).toBe(
      TELEGRAM_CALLBACK_DATA_MAX_BYTES + 1
    );
  });

  it("AT the limit: the attachment is composed, naming the full set", () => {
    const a = usualRoutineAttachmentFor(OFFER, atLimit);
    expect(a).not.toBeNull();
    expect(a!.token).toBe(atLimit);
    expect(a!.label).toContain("(5)");
    for (const name of ["Fermented foods", "Berries", "Creatine"]) {
      expect(a!.line).toContain(name);
    }
  });

  it("ONE BYTE OVER: no attachment at all — never a shorter one", () => {
    expect(usualRoutineAttachmentFor(OFFER, oneOver)).toBeNull();
    // And not "the same offer with a trimmed token": a truncation would have answered
    // something whose token was inside the budget.
    expect(
      usualRoutineAttachmentFor({ ...OFFER, doses: [] }, oneOver)
    ).toBeNull();
    expect(
      usualRoutineAttachmentFor({ ...OFFER, groups: [] }, oneOver)
    ).toBeNull();
  });

  it("ONE BYTE OVER: the host message is exactly what it was, line included", () => {
    const out = attachUsualRoutine(
      host(),
      usualRoutineAttachmentFor(OFFER, oneOver)
    );
    // The whole button is gone, so the host keeps its own keyboard untouched…
    expect(out.actions).toEqual(host().actions);
    expect(
      usualTokenOn([[{ callback_data: out.actions?.[0]?.data }]])
    ).toBeNull();
    // …and the body promises nothing, because no tap can honour it.
    expect(plainBody(out.body)).toBe(plainBody(host().body));
    expect(plainBody(out.body)).not.toContain("Your usual");
    // A message that never got the decoration is a fine message to send.
    expect(usualDispatchProblem(out)).toBeNull();
  });
});
