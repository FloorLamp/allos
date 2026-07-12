// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Exercises resolveProviderIdByName (issue #534) against the real providers table:
// the reuse-vs-create decision at the write boundary. Before #534 a typed name took
// the lowest-id name match unconditionally, silently linking a record onto a
// genuinely distinct same-named provider; now an ambiguous name resolves to a
// DISTINCT row rather than mis-linking. Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { resolveProviderIdByName, getProvider } from "@/lib/providers-db";

function seedProvider(
  name: string,
  type: "organization" | "individual",
  dedup: string
): number {
  return Number(
    db
      .prepare(`INSERT INTO providers (name, type, dedup_key) VALUES (?, ?, ?)`)
      .run(name, type, dedup).lastInsertRowid
  );
}

describe("resolveProviderIdByName (issue #534)", () => {
  it("reuses a unique existing name match", () => {
    const id = seedProvider("Quest Diagnostics Alpha", "organization", "qda");
    expect(resolveProviderIdByName("Quest Diagnostics Alpha")).toBe(id);
    // Case/whitespace-insensitive reuse.
    expect(resolveProviderIdByName("  quest diagnostics ALPHA ")).toBe(id);
  });

  it("reuses a lone same-named individual even when entering as organization", () => {
    const id = seedProvider("Dr. Nova Beta", "individual", "nb");
    // Manual entry defaults to organization, but a single known clinician of that
    // name is still reused (not duplicated).
    expect(resolveProviderIdByName("Dr. Nova Beta")).toBe(id);
  });

  it("does NOT collapse two distinct same-named providers", () => {
    // Two "City Medical Gamma" orgs with distinct dedup keys (different rows) —
    // exactly the same-name-different-entity case #534 guards.
    const a = seedProvider("City Medical Gamma", "organization", "cmg-a");
    const b = seedProvider("City Medical Gamma", "organization", "cmg-b");
    const resolved = resolveProviderIdByName("City Medical Gamma");
    // The ambiguous name must not silently attach to either distinct row; it
    // resolves to a THIRD, distinct plain-name row instead.
    expect(resolved).not.toBe(a);
    expect(resolved).not.toBe(b);
    expect(getProvider(resolved!)).toBeDefined();
  });

  it("stays idempotent for a repeated ambiguous entry (one new distinct row)", () => {
    seedProvider("Repeat Clinic Delta", "organization", "rcd-a");
    seedProvider("Repeat Clinic Delta", "organization", "rcd-b");
    const first = resolveProviderIdByName("Repeat Clinic Delta");
    const second = resolveProviderIdByName("Repeat Clinic Delta");
    // The dedup_key (name:organization:...) converges the repeat on the same new
    // row rather than coining a fresh duplicate each time.
    expect(second).toBe(first);
  });

  it("returns null for a blank name (unlink)", () => {
    expect(resolveProviderIdByName("   ")).toBeNull();
  });
});
