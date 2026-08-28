import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import SkinLesionList from "@/app/(app)/records/specialty/skin/SkinLesionList";
import type { SkinLesion } from "@/lib/types";

// Only the write path is stubbed — the list renders for real, so this observes
// the anatomy the two lesion status mounts actually produce (#3776).
vi.mock("@/app/(app)/records/specialty/skin/actions", () => ({
  updateSkinLesion: vi.fn(),
  deleteSkinLesion: vi.fn(),
  trackSkinFollowUp: vi.fn(),
}));

// jsdom ships neither ResizeObserver nor matchMedia, and the shared shell this
// list renders inside reads both. The matchMedia stub is the one
// components/__tests__/activity-editor-surface.test.tsx already installs.
beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
});

function lesion(id: number, status: string): SkinLesion {
  return {
    id,
    profile_id: 1,
    label: `mole ${id}`,
    body_region: "back",
    status,
    observed_date: "2026-08-01",
    asymmetry: 0,
    border: 0,
    color: 0,
    diameter: 0,
    evolving: 0,
    size_mm: null,
    finding: null,
    notes: null,
    created_at: "2026-08-01T12:00:00Z",
  } as unknown as SkinLesion;
}

// A lesion renders its status TWICE — once on the group heading, once on the
// observation row — and #3776 folded both onto the shared clinical pill. The
// old local badge printed a lower-cased word in its own `rounded-sm` box; the
// shared owner prints the #643 casing inside `badge`, so "Watch" and the class
// together are what separate the converged tree from the duplicate.
describe("skin lesion status mounts", () => {
  it.each([
    ["active", "Active", "amber"],
    ["watch", "Watch", "amber"],
    ["removed", "Removed", "slate"],
  ])("%s renders as the shared %s pill", (status, text, family) => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <SkinLesionList items={[lesion(1, status)]} />
        </ConfirmProvider>
      </ToastProvider>
    );
    // Scoped to the lesion card, so the status FILTER pills above it (which
    // carry the same three words) cannot stand in for a status mount.
    const card = within(screen.getByTestId("lesion-card"));
    const pills = card.getAllByText(text);
    expect(pills).toHaveLength(2);
    for (const pill of pills) {
      expect(pill.className).toContain("badge");
      expect(pill.className).toContain(family);
    }
    expect(card.queryByText(status.toLowerCase())).toBeNull();
  });
});
