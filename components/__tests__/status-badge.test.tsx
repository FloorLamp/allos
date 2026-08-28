import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StatusBadge from "@/components/StatusBadge";
import { skinLesionStatusLabel } from "@/lib/skin-lesion";

// The one clinical-status pill (#643), now also the skin lesion lifecycle's
// (#3776). Tone is asserted as the COLOR FAMILY rather than the literal class
// string: what #643 guarantees is that the same status reads the same on every
// list, and a palette re-tune must not have to edit this table to keep saying so.
function tone(status: string | null): string {
  render(<StatusBadge status={status} />);
  const cls = screen.getByText(/\S/).className;
  return /amber|emerald|sky|slate-400/.test(cls)
    ? (cls.match(/amber|emerald|sky|slate-400/) as RegExpMatchArray)[0]
    : "slate";
}

describe("StatusBadge", () => {
  // The lesion mounts pass their status through skinLesionStatusLabel, which
  // owns the lifecycle wording AND the off-vocabulary degrade: anything not in
  // the CHECK set reads as Active, matching normalizeSkinLesionStatus. So a
  // null lesion status must NOT reach the shared badge's em-dash placeholder.
  it.each([
    ["active", "Active", "amber"],
    ["watch", "Watch", "amber"],
    ["removed", "Removed", "slate"],
    ["ACTIVE", "Active", "amber"],
    ["Removed", "Removed", "slate"],
    [null, "Active", "amber"],
    ["bogus", "Active", "amber"],
  ])("lesion %s reads %s", (status, text, family) => {
    const label = skinLesionStatusLabel(status);
    expect(label).toBe(text);
    expect(tone(label)).toBe(family);
    expect(screen.getByText(text)).toBeTruthy();
  });

  // The four families #643 unified. They pass the stored status straight
  // through, so this is the converse of the table above: teaching the tone map
  // `watch` and `removed` must not have moved any of them.
  it.each([
    ["active", "Active", "amber"],
    ["resolved", "Resolved", "emerald"],
    ["inactive", "Inactive", "slate"],
    ["proposed", "Proposed", "sky"],
    ["achieved", "Achieved", "emerald"],
    ["on hold", "On hold", "slate"],
  ])("condition/allergy/care %s reads %s", (status, text, family) => {
    expect(tone(status)).toBe(family);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("renders the muted placeholder for a stored null status", () => {
    render(<StatusBadge status={null} />);
    const dash = screen.getByText("—");
    expect(dash.className).toContain("slate-400");
  });
});
