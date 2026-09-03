// The send/rebuild composition (#4538) — the pure half.
//
// `composeMessage` is the ONE place a title gains its attribution label, a keyboard
// gains its chat-origin marks, and the pre-dispatch assertion runs. Three of its four
// steps are applied twice in the real system — the tick marks a food nudge and then
// `dispatch` marks it again; the sweep attaches the bundle before it plans and the
// chokepoint attaches it again on the rebuild — so their idempotency is load-bearing
// rather than incidental, and it is pinned here rather than trusted.
//
// The fourth, the prefix, is NOT idempotent, which is exactly why nothing outside this
// module can apply one: `prefixMessage` no longer exists as an export, so "apply it at
// the call site" is not a thing the type system permits any more.
import { describe, it, expect } from "vitest";
import { composeMessage } from "../notifications/compose";
import { withChatOrigin } from "../notifications/chat-origin";
import { attachUsualRoutine } from "../notifications/usual-routine-attach";
import { dispatchableUsual } from "../notifications/usual-routine-plan";
import type { NotificationMessage } from "../notifications/types";

const A = {
  token: "usual:7:41",
  label: "✅ Your usual Morning (3)",
  line: "✅ Your usual Morning: eggs, D3",
};

const host = (): NotificationMessage => ({
  title: "🍽 Log food",
  body: "What have you eaten?",
  actions: [
    { label: "Eggs", data: "food:7:Morning:2026-09-02:eggs", row: "r1" },
    {
      label: "Protein",
      data: "foodprotein:7:Morning:2026-09-02:30",
      row: "r1",
    },
  ],
});

describe("the composed steps that are applied twice are idempotent", () => {
  it.each([
    [
      "withChatOrigin",
      (m: NotificationMessage) => withChatOrigin(m, "telegram-command"),
    ],
    [
      "attachUsualRoutine",
      (m: NotificationMessage) => attachUsualRoutine(m, A),
    ],
    ["dispatchableUsual", (m: NotificationMessage) => dispatchableUsual(m)],
    [
      "composeMessage (no prefix)",
      (m: NotificationMessage) => composeMessage(m, "", "telegram-command", A),
    ],
  ])("%s: twice equals once", (_name, step) => {
    const once = step(host());
    expect(step(once)).toEqual(once);
  });

  it("re-attaching does not promise the same write twice", () => {
    const once = attachUsualRoutine(host(), A);
    const twice = attachUsualRoutine(once, A);
    for (const m of [once, twice])
      expect(String(m.body).split(A.line).length - 1).toBe(1);
  });

  it("a DIFFERENT origin overwrites the marker rather than stacking one", () => {
    const cmd = withChatOrigin(host(), "telegram-command");
    expect(cmd.actions![0].data).toBe("food:c:7:Morning:2026-09-02:eggs");
    expect(withChatOrigin(cmd, "telegram-nudge").actions![0].data).toBe(
      "food:n:7:Morning:2026-09-02:eggs"
    );
  });
});

// The step that is NOT idempotent, stated as the reason for the design rather than
// left as a hazard a call site has to remember. A second application really does
// double the label — so there is exactly one application point, and no export that
// would let a call site add a second.
it("the prefix is applied once because a second application would show", () => {
  const once = composeMessage(host(), "[Ada] ");
  expect(once.title).toBe("[Ada] 🍽 Log food");
  expect(composeMessage(once, "[Ada] ").title).toBe("[Ada] [Ada] 🍽 Log food");
});

it("an empty prefix returns the message itself — nothing is copied for nothing", () => {
  const m = host();
  expect(composeMessage(m, "")).toBe(m);
});

// THE PAIR, at the pure tier: a send composes a host that already carries the bundle;
// a rebuild composes a fresh builder render plus the attachment re-derived off the
// delivered keyboard. Different arguments, same output — which is what "a rebuild is
// keyboard-identical to its send" means before any database is involved.
it("a send and a rebuild of the same message compose identically", () => {
  const sent = composeMessage(
    attachUsualRoutine(host(), A),
    "[Ada] ",
    "telegram-command"
  );
  const rebuilt = composeMessage(
    withChatOrigin(host(), "telegram-command"),
    "[Ada] ",
    null,
    A
  );
  expect(rebuilt).toEqual(sent);
});
