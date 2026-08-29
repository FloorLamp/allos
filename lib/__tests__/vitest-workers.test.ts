import { describe, expect, it } from "vitest";
import { dbWorkerCount } from "@/lib/__db_tests__/worker-count";

describe("DB test worker count", () => {
  it("caps wide hosts so the database module graph is not multiplied per CPU", () => {
    expect(dbWorkerCount(16)).toBe(12);
    expect(dbWorkerCount(64)).toBe(12);
  });

  it("preserves Vitest's default on constrained hosts", () => {
    expect(dbWorkerCount(4)).toBe(3);
    expect(dbWorkerCount(2)).toBe(1);
    expect(dbWorkerCount(1)).toBe(1);
  });
});
