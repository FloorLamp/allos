// Pure tests for the practice token family (#2961 step 2). The three builders and
// their parsers had no pure coverage before the carve, so a moved parser had nothing
// that could go red; each row here is the mutation control for one of them.
import { describe, it, expect } from "vitest";
import {
  parsePracticeDoneCallback,
  parsePracticeLogCallback,
  parseRightSizeLowerCallback,
  practiceDoneCallback,
  practiceLogCallback,
  rightSizeLowerCallback,
} from "@/lib/notifications/practice-tokens";

describe("practice tokens round-trip through their own parser and no other", () => {
  it.each([
    ["pdone", practiceDoneCallback(7, 42, "n1"), parsePracticeDoneCallback],
    ["plog", practiceLogCallback(7, 42, "n1"), parsePracticeLogCallback],
  ])("%s", (prefix, token, parse) => {
    expect(token).toBe(`${prefix}:7:42:n1`);
    expect(parse(token)).toEqual({ profileId: 7, targetId: 42, token: "n1" });
    for (const other of [parsePracticeDoneCallback, parsePracticeLogCallback])
      if (other !== parse) expect(other(token)).toBeNull();
  });

  it("rslower carries ids only", () => {
    const token = rightSizeLowerCallback(7, 42);
    expect(token).toBe("rslower:7:42");
    expect(parseRightSizeLowerCallback(token)).toEqual({
      profileId: 7,
      targetId: 42,
    });
  });

  it.each([
    ["pdone:0:42:n1", parsePracticeDoneCallback],
    ["pdone:7:0:n1", parsePracticeDoneCallback],
    ["pdone:7:42:", parsePracticeDoneCallback],
    ["plog:7:42", parsePracticeLogCallback],
    ["rslower:7:0", parseRightSizeLowerCallback],
    ["rslower:0:42", parseRightSizeLowerCallback],
    [null, parseRightSizeLowerCallback],
  ])("rejects %s", (token, parse) => {
    expect(parse(token)).toBeNull();
  });
});
