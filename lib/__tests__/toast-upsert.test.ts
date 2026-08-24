import { describe, it, expect } from "vitest";
import {
  upsertToast,
  dismissKeyed,
  beginExit,
  dropExited,
  visibleToasts,
  acceptsProfileToast,
  clearProfileToasts,
  type KeyedToast,
} from "@/lib/toast-upsert";

// The keyed-upsert semantics behind the merged toast system (#1315): a toast with a
// `key` replaces the live toast of the same key IN PLACE (position kept, id kept,
// revision bumped so the timer resets); a keyless toast always stacks; dismissing an
// unknown key is a no-op.

interface T extends KeyedToast {
  message: string;
}

function t(over: Partial<T> & { id: number }): T {
  return { key: undefined, revision: 0, message: "", ...over };
}

describe("upsertToast", () => {
  it("appends a keyless toast (always stacks)", () => {
    const list = [t({ id: 1, message: "a" })];
    const next = upsertToast(list, t({ id: 2, message: "b" }));
    expect(next.map((x) => x.message)).toEqual(["a", "b"]);
  });

  it("appends a keyed toast whose key isn't live yet", () => {
    const list = [t({ id: 1, key: "x", message: "a" })];
    const next = upsertToast(list, t({ id: 2, key: "y", message: "b" }));
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: 2, key: "y", message: "b" });
  });

  it("replaces a same-key toast IN PLACE, keeping id + position", () => {
    const list = [
      t({ id: 1, key: "upload", message: "Uploaded…" }),
      t({ id: 2, key: "other", message: "z" }),
    ];
    const next = upsertToast(
      list,
      t({ id: 99, key: "upload", message: "12 records ✓" })
    );
    // Same length (no stack), same order, and the slot kept its original id.
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      id: 1,
      key: "upload",
      message: "12 records ✓",
    });
    expect(next[1].message).toBe("z");
  });

  it("bumps the revision on an in-place replace (resets the timer)", () => {
    let list = [t({ id: 1, key: "k", message: "a" })];
    list = upsertToast(list, t({ id: 2, key: "k", message: "b" }));
    expect(list[0].revision).toBe(1);
    list = upsertToast(list, t({ id: 3, key: "k", message: "c" }));
    expect(list[0].revision).toBe(2);
    expect(list[0].id).toBe(1);
  });
});

describe("profile toast generations", () => {
  it("rejects an old in-flight completion after switch and same-profile relogin", () => {
    const oldA = { profileId: 7, profileToken: 1 };
    expect(acceptsProfileToast({ profileId: 8, token: 2 }, oldA)).toBe(false);
    expect(acceptsProfileToast({ profileId: 7, token: 3 }, oldA)).toBe(false);
    expect(acceptsProfileToast({ profileId: 7, token: 1 }, oldA)).toBe(true);
  });

  it("logout rejects completions and clears all profile-owned queue slots", () => {
    const list = [
      t({ id: 1, profileId: 7, profileToken: 1, message: "A" }),
      t({ id: 2, message: "generic" }),
    ];
    expect(acceptsProfileToast(null, list[0])).toBe(false);
    expect(clearProfileToasts(list).map((toast) => toast.id)).toEqual([2]);
  });
});

describe("dismissKeyed", () => {
  it("removes the live toast with the key", () => {
    const list = [
      t({ id: 1, key: "upload", message: "a" }),
      t({ id: 2, key: "doc-5", message: "b" }),
    ];
    expect(dismissKeyed(list, "upload").map((x) => x.id)).toEqual([2]);
  });

  it("is a no-op for an unknown key", () => {
    const list = [t({ id: 1, key: "upload", message: "a" })];
    expect(dismissKeyed(list, "nope")).toEqual(list);
  });

  it("leaves keyless toasts untouched", () => {
    const list = [t({ id: 1, message: "a" }), t({ id: 2, message: "b" })];
    expect(dismissKeyed(list, "upload")).toHaveLength(2);
  });
});

// ── The phone queue (#3373) ──────────────────────────────────────────────────
//
// Below `md` a toast is a full-width bar on the bottom edge, so exactly one is on
// screen and the rest wait their turn. There is no second data structure: the
// queue is this list plus a head selection, which is what keeps the keyed-upsert
// semantics above intact while the phone shows one at a time.
//
// The three behaviours that are only observable in composition — an upgrade
// landing on a WAITING toast, an upgrade landing DURING a dismissal, and the
// hand-over that a dismissal starts — are the ones this section pins. A queued
// toast has no rendered card and therefore no running timer, so "one at a time"
// costs nothing in dropped announcements: it announces when it is shown.
describe("visibleToasts", () => {
  const list = [
    t({ id: 1, message: "first" }),
    t({ id: 2, message: "second" }),
    t({ id: 3, message: "third" }),
  ];

  it("shows the whole stack from `md` up", () => {
    expect(visibleToasts(list, false)).toEqual(list);
  });

  it("shows exactly the head below `md`, in post order", () => {
    expect(visibleToasts(list, true).map((x) => x.message)).toEqual(["first"]);
  });

  it("is empty only when the list is", () => {
    expect(visibleToasts([], true)).toEqual([]);
  });

  it("hands over to the NEXT toast in order once the head is gone", () => {
    // Two rapid toasts show one at a time, in the order they were posted — the
    // second is not dropped, it is waiting.
    let queue = [t({ id: 1, message: "saved" })];
    queue = upsertToast(queue, t({ id: 2, message: "deleted" }));
    expect(visibleToasts(queue, true).map((x) => x.message)).toEqual(["saved"]);

    queue = beginExit(queue, 1);
    // While the head is leaving it still owns the slot, so the next bar arrives
    // AFTER it has gone rather than sliding in underneath it.
    expect(visibleToasts(queue, true).map((x) => x.message)).toEqual(["saved"]);

    queue = dropExited(queue, 1);
    expect(visibleToasts(queue, true).map((x) => x.message)).toEqual([
      "deleted",
    ]);
  });

  it("upgrades the VISIBLE bar in place on a keyed replace, without reordering", () => {
    let queue = [t({ id: 1, key: "upload", message: "Uploaded…" })];
    queue = upsertToast(queue, t({ id: 2, message: "deleted" }));
    queue = upsertToast(queue, t({ id: 3, key: "upload", message: "12 ✓" }));

    // The keyed post is an upgrade, not a new arrival: still two toasts, the
    // visible one is still the upload slot, and its revision bumped so the card
    // restarts its countdown on the new message.
    expect(queue).toHaveLength(2);
    const [head] = visibleToasts(queue, true);
    expect(head).toMatchObject({ id: 1, message: "12 ✓", revision: 1 });
  });

  it("edits a WAITING toast without promoting it past the visible one", () => {
    let queue = [t({ id: 1, message: "saved" })];
    queue = upsertToast(
      queue,
      t({ id: 2, key: "upload", message: "Uploaded…" })
    );
    queue = upsertToast(queue, t({ id: 3, key: "upload", message: "12 ✓" }));

    expect(visibleToasts(queue, true).map((x) => x.message)).toEqual(["saved"]);
    expect(queue[1]).toMatchObject({ id: 2, message: "12 ✓" });
  });
});

describe("beginExit / dropExited", () => {
  it("marks the toast without removing it", () => {
    const list = [t({ id: 1, message: "a" }), t({ id: 2, message: "b" })];
    const next = beginExit(list, 1);
    expect(next).toHaveLength(2);
    expect(next[0].exiting).toBe(true);
    expect(next[1].exiting).toBeUndefined();
  });

  it("returns the SAME array when there is nothing to mark", () => {
    // A double dismissal — the auto-dismiss timer firing on a card the reader
    // just closed — must not re-render the stack or restart the animation.
    const list = [t({ id: 1, message: "a" })];
    const exiting = beginExit(list, 1);
    expect(beginExit(exiting, 1)).toBe(exiting);
    expect(beginExit(list, 404)).toBe(list);
  });

  it("removes only a toast that is still exiting", () => {
    const list = beginExit([t({ id: 1, message: "a" })], 1);
    expect(dropExited(list, 1)).toEqual([]);
    expect(dropExited([t({ id: 1, message: "a" })], 1)).toHaveLength(1);
  });

  it("lets a keyed upgrade CANCEL a dismissal already in flight", () => {
    // The narrow race the `exiting: false` in upsertToast exists for: a keyed
    // replace arriving inside the exit window would otherwise put the new message
    // into a bar that is still sliding away, and the pending removal would then
    // take the upgrade off screen — an upgrade that looked like it never arrived.
    let list = [t({ id: 1, key: "upload", message: "Uploaded…" })];
    list = beginExit(list, 1);
    list = upsertToast(list, t({ id: 9, key: "upload", message: "12 ✓" }));
    expect(list[0]).toMatchObject({ id: 1, message: "12 ✓", exiting: false });
    // …and the removal that was already scheduled leaves it alone.
    expect(dropExited(list, 1)).toHaveLength(1);
  });
});
