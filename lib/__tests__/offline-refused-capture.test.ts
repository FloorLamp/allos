// PURE TIER — the refused-capture sentence's SOURCE-SCAN half (#3038).
//
// `enqueue` (components/OfflineQueueProvider) answers whether the device kept the
// write, and every quick-log surface must read that answer and refuse honestly —
// with ONE shared sentence, `OFFLINE_CAPTURE_REFUSED_MESSAGE`. The per-surface
// behavior (copy rendered, optimistic state rolled back) lives in the e2e tier
// (e2e/offline-refused-capture.spec.ts, e2e/offline-write-gate.spec.ts R-5);
// what types and browsers both leave open is the CALL-SITE fact this scan pins:
//
//   1. Every component that takes `enqueue` from `useOfflineQueue()` references
//      the shared constant — a ninth surface added later cannot quietly toast
//      "saved offline" with no refused branch at all.
//   2. The sentence exists ONCE, in lib/offline/queue.ts — nobody re-declares a
//      near-copy that drifts on the next edit.
//
// Proven on the defect: on the pre-#3038 tree (with only the constant stubbed in),
// direction 1 fails naming all ten surfaces — the eight the issue counts, which
// ignored the boolean outright, plus DoseStatusControl and LogPracticeButton,
// which read it but carried their own copies of the sentence.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OFFLINE_CAPTURE_REFUSED_MESSAGE } from "@/lib/offline/queue";
import { REPO, relPath } from "./sql-scan";

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(p);
      } else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
        out.push(p);
      }
    }
  };
  walk(path.join(REPO, "components"));
  walk(path.join(REPO, "app"));
  return out.filter((f) => !relPath(f).includes("__tests__"));
}

// A surface that HOLDS the queue's enqueue. The provider itself defines the API
// (and documents the answer's meaning); it is not a surface.
function takesEnqueue(src: string, rel: string): boolean {
  return (
    rel !== "components/OfflineQueueProvider.tsx" &&
    src.includes("useOfflineQueue()")
  );
}

describe("every offline quick-log surface answers a refused capture with the one shared sentence (#3038)", () => {
  const files = clientFiles().map((f) => ({
    rel: relPath(f),
    src: fs.readFileSync(f, "utf8"),
  }));

  it("every consumer of the queue's enqueue references OFFLINE_CAPTURE_REFUSED_MESSAGE", () => {
    const silent = files
      .filter(
        (f) =>
          takesEnqueue(f.src, f.rel) &&
          !f.src.includes("OFFLINE_CAPTURE_REFUSED_MESSAGE")
      )
      .map((f) => f.rel);
    expect(silent, `\n${silent.join("\n")}\n`).toEqual([]);
  });

  it("the sentence is declared once, not paraphrased per surface", () => {
    const copies = files
      .filter((f) => f.src.includes(OFFLINE_CAPTURE_REFUSED_MESSAGE))
      .map((f) => f.rel);
    expect(copies, `\n${copies.join("\n")}\n`).toEqual([]);
  });

  // The guard must be able to fail (the #1893 fixture rule).
  it("FLAGS a planted surface that takes enqueue and never references the constant", () => {
    const planted = `const { enqueue } = useOfflineQueue();`;
    expect(takesEnqueue(planted, "components/f.tsx")).toBe(true);
    expect(planted.includes("OFFLINE_CAPTURE_REFUSED_MESSAGE")).toBe(false);
  });
});
