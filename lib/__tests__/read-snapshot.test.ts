import { describe, expect, it } from "vitest";
import { snapshotCached, withReadSnapshot } from "../read-snapshot";

describe("bounded read snapshots", () => {
  it("deduplicates by explicit key only inside the scope", async () => {
    let reads = 0;
    const read = snapshotCached(
      "test.read",
      (profileId: number) => String(profileId),
      (profileId: number) => ({ profileId, read: ++reads })
    );

    expect(read(1).read).toBe(1);
    expect(read(1).read).toBe(2);

    await withReadSnapshot(async () => {
      const first = read(1);
      await Promise.resolve();
      expect(read(1)).toBe(first);
      expect(read(2).read).toBe(4);
    });

    expect(read(1).read).toBe(5);
  });
});
