// The next/cache spies, as ONE stable instance per module registry.
//
// They live here rather than inside setup.ts's `vi.mock("next/cache")` factory
// because that factory re-runs for every test file. Under `isolate: true` that is
// invisible — a fresh registry per file means the fresh spies are the only ones in
// play. Under a SHARED registry it breaks: the factory mints new vi.fn()s while the
// server actions, already imported by an earlier file, keep calling the previous
// ones, so a spec asserts against a spy its own action never touched. That was 64
// of 165 action specs failing on `expected "vi.fn()" to be called with [...]`.
//
// A plain module is evaluated once per registry, so returning THESE from the
// factory gives actions and specs the same spy in both tiers. setup.ts clears them
// per file, which reproduces exactly what a fresh-registry file used to get.
import { vi } from "vitest";

export const revalidatePath = vi.fn();
export const revalidateTag = vi.fn();
