import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Item 11 acceptance (#856): the episode page logs symptoms/temperature through the SAME
// SymptomLogBar — ZERO forked logging logic (the responsive/shared-content rule; a
// mirrored second logging surface is exactly the drift the conventions forbid). This
// source-scan pins that EpisodeLogPanel mounts that shared component and never
// re-implements the logging actions itself.
//
// The dashboard `SymptomLogCard` was the other half of this comparison until #2957
// deleted it — it rendered on no screen, so half of what this file compared was dead
// code. What remains is the half that mounts.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("episode-page logging reuses the shared SymptomLogBar (#856 item 11)", () => {
  const panel = read("components/illness/EpisodeLogPanel.tsx");

  it("EpisodeLogPanel mounts the shared SymptomLogBar rather than its own", () => {
    const importRe = /import\s+SymptomLogBar\s+from\s+["']([^"']+)["']/;
    const panelSrc = panel.match(importRe)?.[1];
    expect(panelSrc).toBeTruthy();
    expect(panelSrc?.endsWith("/SymptomLogBar")).toBe(true);
    expect(panel).toContain("<SymptomLogBar");
  });

  it("EpisodeLogPanel does NOT re-implement the symptom/temperature log actions", () => {
    // A forked surface would import the raw log actions and call them itself. The panel
    // must delegate entirely to the bar, so it references none of them.
    for (const forbidden of ["logSymptom", "logTemperature", "removeSymptom"]) {
      expect(panel.includes(forbidden)).toBe(false);
    }
  });
});
