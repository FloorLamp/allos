import { describe, expect, it } from "vitest";
import {
  nearestSessionElapsedIndex,
  sessionElapsedSeconds,
} from "@/lib/session-chart-link";

describe("ride chart linking", () => {
  it("parses both minute and hour elapsed labels", () => {
    expect(sessionElapsedSeconds("12:30")).toBe(750);
    expect(sessionElapsedSeconds("1:02:03")).toBe(3723);
    expect(sessionElapsedSeconds("bad")).toBeNull();
  });

  it("snaps unlike sampling rates to the nearest elapsed point", () => {
    expect(nearestSessionElapsedIndex(["0:00", "1:00", "2:00"], "1:22")).toBe(
      1
    );
    expect(nearestSessionElapsedIndex(["0:03", "0:59", "2:01"], "1:00")).toBe(
      1
    );
  });
});
