import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Item 11 acceptance (#856): the episode page logs symptoms/temperature through the SAME
// SymptomLogBar the dashboard SymptomLogCard uses — ZERO forked logging logic (the
// responsive/shared-content rule; a mirrored second logging surface is exactly the drift
// the conventions forbid). This source-scan pins that EpisodeLogPanel mounts that shared
// component from the same module and never re-implements the logging actions itself.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("episode-page logging reuses the shared SymptomLogBar (#856 item 11)", () => {
  const panel = read("components/illness/EpisodeLogPanel.tsx");
  const card = read("app/(app)/symptoms/SymptomLogCard.tsx");

  it("EpisodeLogPanel imports the SAME SymptomLogBar the dashboard card imports", () => {
    const importRe = /import\s+SymptomLogBar\s+from\s+["']([^"']+)["']/;
    const panelSrc = panel.match(importRe)?.[1];
    const cardSrc = card.match(importRe)?.[1];
    expect(panelSrc).toBeTruthy();
    // Both resolve to the one component (the panel via the @/ alias, the card via a
    // relative path) — normalize to the module basename.
    expect(panelSrc?.endsWith("/SymptomLogBar")).toBe(true);
    expect(cardSrc?.endsWith("SymptomLogBar")).toBe(true);
  });

  it("EpisodeLogPanel does NOT re-implement the symptom/temperature log actions", () => {
    // A forked surface would import the raw log actions and call them itself. The panel
    // must delegate entirely to the bar, so it references none of them.
    for (const forbidden of ["logSymptom", "logTemperature", "removeSymptom"]) {
      expect(panel.includes(forbidden)).toBe(false);
    }
  });
});
