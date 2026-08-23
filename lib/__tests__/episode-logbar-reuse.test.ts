import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNMOUNTED_ROOTS } from "./unmounted-roots";

// Item 11 acceptance (#856): the episode page logs symptoms/temperature through the SAME
// SymptomLogBar the dashboard SymptomLogCard uses — ZERO forked logging logic (the
// responsive/shared-content rule; a mirrored second logging surface is exactly the drift
// the conventions forbid). This source-scan pins that EpisodeLogPanel mounts that shared
// component from the same module and never re-implements the logging actions itself.
//
// ONE OF ITS TWO SUBJECTS IS DEAD CODE, AND SAYING SO IS THE POINT (#3580 item 5).
// `components/illness/SymptomLogCard.tsx` is imported by nothing in `app/` or
// `components/` — it is the one entry in `UNMOUNTED_ROOTS`, the registry the
// surface-wiring census keeps of files whose mount chain legitimately ends nowhere.
// This test reads its bytes and asserts on them, so it passes and will keep passing
// whether or not anything ever mounts it: the comparison it makes is real, and the
// half it compares AGAINST renders on no screen.
//
// That is recorded rather than repaired because deleting a component is a different
// decision from noticing that a guard pins it. What is repaired is the DRIFT: the
// claim now reads from the registry instead of sitting in prose, so deleting the
// component means deleting its registry line, and deleting its registry line turns
// this file red with the reason attached.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

const CARD = "components/illness/SymptomLogCard.tsx";

describe("episode-page logging reuses the shared SymptomLogBar (#856 item 11)", () => {
  const panel = read("components/illness/EpisodeLogPanel.tsx");
  const card = read(CARD);

  it("says out loud that the card half of this comparison renders nowhere", () => {
    // A guard whose subject nothing mounts cannot fail in a way anybody feels, and a
    // reader deserves to learn that from the test rather than from a mount-graph walk
    // in another file. Reading the registry — rather than repeating its claim — is
    // what keeps the two statements from drifting apart.
    expect(
      Object.keys(UNMOUNTED_ROOTS),
      `${CARD} is no longer registered as unmounted. If something now renders it, ` +
        "this file's comparison has become live and this assertion should go; if it " +
        "was deleted, delete this file's card half with it."
    ).toContain(CARD);
    expect(UNMOUNTED_ROOTS[CARD].length).toBeGreaterThan(40);
  });

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
