import { describe, it, expect } from "vitest";
import { trimJsonlLines } from "../jsonl-trim";

// The sinks' real budgets (lib/ai-log.ts / lib/error-log.ts): trim triggers
// past 5MB and the kept tail must fit 2000 lines AND half the trigger.
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_LINES = 2000;
const KEEP_BYTES = MAX_BYTES / 2;

function joinedBytes(lines: string[]): number {
  return Buffer.byteLength(lines.join("\n") + "\n", "utf8");
}

describe("trimJsonlLines", () => {
  it("brings a file of 4KB lines back under the byte trigger (#1841)", () => {
    // The exact case the old line-count trim failed: per-line free text is
    // capped at 4000 chars, so 2000 retained lines ≈ 8.4MB > 5MB — the trim
    // never converged and every append rewrote the whole file.
    const lines = Array.from(
      { length: 2500 },
      (_, i) => `{"id":"${i}","detail":"${"x".repeat(4000)}"}`
    );
    const kept = trimJsonlLines(lines, KEEP_LINES, KEEP_BYTES);
    expect(joinedBytes(kept)).toBeLessThanOrEqual(KEEP_BYTES);
    expect(joinedBytes(kept)).toBeLessThan(MAX_BYTES);
    // The byte budget binds before the line budget here (~600 fat lines fit),
    // and the newest lines are the ones kept.
    expect(kept.length).toBeLessThan(KEEP_LINES);
    expect(kept[kept.length - 1]).toBe(lines[lines.length - 1]);
    expect(kept[0]).toBe(lines[lines.length - kept.length]);
  });

  it("converges: trimming an already-trimmed tail is a no-op", () => {
    const lines = Array.from(
      { length: 2500 },
      (_, i) => `{"id":"${i}","detail":"${"x".repeat(4000)}"}`
    );
    const once = trimJsonlLines(lines, KEEP_LINES, KEEP_BYTES);
    expect(trimJsonlLines(once, KEEP_LINES, KEEP_BYTES)).toEqual(once);
  });

  it("still enforces the line budget for thin lines", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `{"id":"${i}"}`);
    const kept = trimJsonlLines(lines, KEEP_LINES, KEEP_BYTES);
    expect(kept.length).toBe(KEEP_LINES);
    expect(kept[0]).toBe(lines[1000]);
    expect(kept[kept.length - 1]).toBe(lines[2999]);
  });

  it("drops empty lines without counting them", () => {
    expect(trimJsonlLines(["a", "", "b", ""], 5, 1000)).toEqual(["a", "b"]);
  });

  it("budgets bytes as utf8, not chars", () => {
    // Four 3-byte chars per line = 13 bytes with the newline, so a 13-byte
    // budget keeps one line; counting chars (5 per line) would have kept both.
    const lines = ["€€€€", "€€€€"];
    expect(trimJsonlLines(lines, 10, 13)).toEqual([lines[1]]);
  });
});
