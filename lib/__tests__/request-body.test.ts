import { describe, it, expect } from "vitest";
import { accumulateBytes } from "@/lib/request-body";

describe("accumulateBytes", () => {
  const cap = 100;

  it("accumulates chunk lengths into a running total", () => {
    const a = accumulateBytes(0, 40, cap);
    expect(a).toEqual({ total: 40, over: false });
    const b = accumulateBytes(a.total, 30, cap);
    expect(b).toEqual({ total: 70, over: false });
  });

  it("stays under the cap right up to the boundary", () => {
    // exactly at cap is NOT over (strictly greater triggers rejection)
    expect(accumulateBytes(60, 40, cap)).toEqual({ total: 100, over: false });
  });

  it("signals over the moment cumulative bytes exceed the cap", () => {
    expect(accumulateBytes(100, 1, cap)).toEqual({ total: 101, over: true });
    expect(accumulateBytes(0, 101, cap)).toEqual({ total: 101, over: true });
  });

  it("treats a single oversized chunk as over immediately", () => {
    expect(accumulateBytes(0, 500, cap).over).toBe(true);
  });
});
