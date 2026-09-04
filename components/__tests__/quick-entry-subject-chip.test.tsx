import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import QuickEntryProvider, {
  useQuickEntry,
} from "@/components/QuickEntryProvider";
import type { QuickEntryForm } from "@/lib/quick-log";
import type { SessionProfile } from "@/lib/auth";

// COMPONENT TIER — the quick-log sheet's title-row subject chip (#4932): defaulting
// per opener, the toggle, and a subject switch discarding what the previous subject
// had staged. `loadQuickEntry` is mocked to answer `unavailable` for every call —
// the mechanism under test is the CHIP/PROVIDER, not any one hosted form's own
// rendering (those forms' own subject wiring is proven where each one already lives:
// quick-symptom-parity.test.tsx, the DB-tier gateItemProfile suites).

const loadQuickEntry = vi.hoisted(() =>
  vi.fn(async (form: QuickEntryForm, subjectProfileId?: number) => ({
    form: "unavailable" as const,
    message: `loaded ${form} for ${subjectProfileId ?? "acting"}`,
  }))
);
vi.mock("@/app/(app)/quick-entry-actions", () => ({ loadQuickEntry }));

const ACTING: SessionProfile = {
  id: 1,
  name: "Dad",
  photo_path: null,
  photo_version: 0,
};
const MIA: SessionProfile = {
  id: 2,
  name: "Mia",
  photo_path: null,
  photo_version: 0,
};
const SAM: SessionProfile = {
  id: 3,
  name: "Sam",
  photo_path: null,
  photo_version: 0,
};

const MEASUREMENTS = {
  form: "measurements" as const,
  defaultDate: "2026-09-03",
  defaultStatedAt: null,
  maxDate: "2026-09-03",
  profileId: ACTING.id,
  weightUnit: "lb" as const,
  temperatureUnit: "F" as const,
  showCompositionEntry: true,
  showGrowth: false,
  showHeadCirc: false,
};

// Opens a form via the real context, so every assertion below drives the API a
// real opener (the dock, a subject-scoped panel) would call — never a shortcut
// into the provider's internals.
function Opener() {
  const { open } = useQuickEntry();
  return (
    <>
      <button onClick={() => open("stool", undefined, MIA.id)}>
        open for Mia
      </button>
      <button onClick={() => open("stool")}>open with no subject</button>
    </>
  );
}

function OpenMeasurementsFor({ subjectId }: { subjectId: number }) {
  const { open } = useQuickEntry();
  return (
    <button onClick={() => open("measurements", undefined, subjectId)}>
      open measurements
    </button>
  );
}

function renderSheet(writableProfiles: SessionProfile[]) {
  return render(
    <ToastProvider>
      <QuickEntryProvider
        measurements={MEASUREMENTS}
        writableProfiles={writableProfiles}
        actingProfileId={ACTING.id}
      >
        <Opener />
      </QuickEntryProvider>
    </ToastProvider>
  );
}

describe("the quick-log sheet's subject chip (#4932)", () => {
  it("defaults to the opener's subject when one is passed", async () => {
    renderSheet([ACTING, MIA, SAM]);
    fireEvent.click(screen.getByText("open for Mia"));

    const chip = await screen.findByTestId("quick-entry-subject-chip");
    expect(chip.textContent).toContain("Mia");
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith("stool", MIA.id)
    );
  });

  it("defaults to the acting profile when the opener names no subject", async () => {
    renderSheet([ACTING, MIA, SAM]);
    fireEvent.click(screen.getByText("open with no subject"));

    const chip = await screen.findByTestId("quick-entry-subject-chip");
    expect(chip.textContent).toContain("Dad");
    // Byte-identical online behavior (#4932/#3416 invariant): the acting-profile
    // path posts no subject id at all.
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith("stool", ACTING.id)
    );
  });

  it("a login with exactly one writable profile renders the chip with no chevron and no block", async () => {
    renderSheet([ACTING]);
    fireEvent.click(screen.getByText("open with no subject"));

    const chip = await screen.findByTestId("quick-entry-subject-chip");
    // No chevron/button semantics: a plain span, not a tappable control.
    expect(chip.tagName).toBe("SPAN");
    fireEvent.click(chip);
    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
  });

  it("toggles the block open and closed on repeated chip taps", async () => {
    renderSheet([ACTING, MIA, SAM]);
    fireEvent.click(screen.getByText("open with no subject"));
    const chip = await screen.findByTestId("quick-entry-subject-chip");

    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByTestId("quick-entry-subject-picker")).not.toBeNull();
    // Tapping the chip again while the block is open closes it UNCHANGED (#4932).
    fireEvent.click(chip);
    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
    expect(chip.textContent).toContain("Dad");
  });

  it("picking a member collapses the block, re-loads for the new subject, and discards staged input", async () => {
    renderSheet([ACTING, MIA, SAM]);
    fireEvent.click(screen.getByText("open with no subject"));
    const chip = await screen.findByTestId("quick-entry-subject-chip");
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith("stool", ACTING.id)
    );

    const bodyBefore = screen.getByTestId("quick-entry-body");
    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId(`quick-entry-subject-option-${SAM.id}`));

    // The block collapsed, the chip now names Sam, and the gather re-ran FOR Sam —
    // one gate, the SAME reader, just a different subject argument.
    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
    expect(chip.textContent).toContain("Sam");
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith("stool", SAM.id)
    );
    // The body remounted under the new subject (discarding anything staged) —
    // proven by identity, not merely by its content, since both render the same
    // "unavailable" shape.
    expect(screen.getByTestId("quick-entry-body")).not.toBe(bodyBefore);
    expect(
      screen
        .getByTestId("quick-entry-body")
        .getAttribute("data-subject-profile-id")
    ).toBe(String(SAM.id));
  });

  it("picking the ALREADY-chosen member just closes the block (no reload)", async () => {
    renderSheet([ACTING, MIA, SAM]);
    fireEvent.click(screen.getByText("open with no subject"));
    const chip = await screen.findByTestId("quick-entry-subject-chip");
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith("stool", ACTING.id)
    );
    loadQuickEntry.mockClear();

    fireEvent.click(chip);
    fireEvent.click(
      screen.getByTestId(`quick-entry-subject-option-${ACTING.id}`)
    );

    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
    expect(loadQuickEntry).not.toHaveBeenCalled();
  });

  it("measurements renders unavailable for a chosen non-acting subject (#4091's gather has no per-subject version)", async () => {
    render(
      <ToastProvider>
        <QuickEntryProvider
          measurements={MEASUREMENTS}
          writableProfiles={[ACTING, MIA]}
          actingProfileId={ACTING.id}
        >
          <OpenMeasurementsFor subjectId={MIA.id} />
        </QuickEntryProvider>
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("open measurements"));
    const unavailable = await screen.findByTestId("quick-entry-unavailable");
    expect(unavailable.textContent).toContain("Switch to this profile");
  });
});
