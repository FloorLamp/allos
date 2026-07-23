import type { Migration } from "../runner";

// Migration 097 — RESERVED SLOT (deliberate no-op). See 096-reserved.ts for the
// full rationale: slots 096/097 belong to a concurrently-developed branch, the
// runner requires contiguous ids, and this branch's own schema change is 098.
export function up(): void {
  // Intentionally empty.
}

export const migration: Migration = {
  id: 97,
  name: "097-reserved",
  up,
};
