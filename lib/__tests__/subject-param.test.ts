import { describe, expect, it } from "vitest";
import { parseSubjectParam } from "@/lib/subject-param";

describe("parseSubjectParam", () => {
  it("accepts a positive profile id and rejects a malformed subject", () => {
    expect(parseSubjectParam("42")).toBe(42);
    expect(parseSubjectParam("abc")).toBeUndefined();
  });
});
