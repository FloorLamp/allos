import { describe, it, expect } from "vitest";
import { upsertToast, dismissKeyed, type KeyedToast } from "@/lib/toast-upsert";

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
