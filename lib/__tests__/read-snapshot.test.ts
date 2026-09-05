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

  // #5012 measured that the Trends sections run with the page's scope closed,
  // and this pins which half of that is NOT the cause. `StreamedSection` resumes
  // the section on a double `setImmediate`, and the scope follows it; what does
  // not follow is the Server Component boundary itself, which no unit tier can
  // reach. Without this, the next reader re-derives the wrong culprit.
  it("survives the macrotask yield StreamedSection resumes on", async () => {
    const read = snapshotCached(
      "test.yield",
      () => "key",
      () => ({})
    );

    await withReadSnapshot(async () => {
      const before = read();
      await new Promise<void>((resolve) =>
        setImmediate(() => setImmediate(resolve))
      );
      expect(read()).toBe(before);
    });
  });
});
