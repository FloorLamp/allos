import { expect, it } from "vitest";
import { formatCount, formatList } from "../format-number";

it.each([
  [1234567, "1,234,567"],
  [1234.56789, "1,234.568"],
  [-1234.5, "-1,234.5"],
] as const)("formats %s with fixed English grouping", (value, expected) => {
  expect(formatCount(value)).toBe(expected);
});

it("joins a list with an English conjunction", () => {
  expect(formatList(["blood pressure", "kidney function", "potassium"])).toBe(
    "blood pressure, kidney function, and potassium"
  );
});
