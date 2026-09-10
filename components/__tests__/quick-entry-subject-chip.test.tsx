import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import QuickEntryProvider, {
  QuickEntryVisitBodies,
  useQuickEntry,
  useQuickEntryVisit,
} from "@/components/QuickEntryProvider";
import type { QuickEntryForm } from "@/lib/quick-log";
import type { SessionProfile } from "@/lib/auth";
import {
  DayContextProvider,
  ProfileDaysBoundary,
} from "@/components/DayContext";
import type { AppRoute } from "@/lib/hrefs";
import { BRISTOL_STOOL_TYPES } from "@/lib/bristol-stool";

// COMPONENT TIER — the quick-log sheet's title-row subject chip (#4932): defaulting
// per opener, the toggle, and a subject switch replacing the previous subject's
// context. `loadQuickEntry` is mocked to answer `unavailable` for every call —
// the mechanism under test is the CHIP/PROVIDER, not any one hosted form's own
// rendering (those forms' own subject wiring is proven where each one already lives:
// quick-symptom-parity.test.tsx, the DB-tier gateItemProfile suites).

const loadQuickEntry = vi.hoisted(() =>
  vi.fn(async (form: QuickEntryForm, subjectProfileId?: number) => ({
    kind: "ready" as const,
    data: {
      form: "unavailable" as const,
      today: MEASUREMENTS.defaultDate,
      message: `loaded ${form} for ${subjectProfileId ?? "acting"}`,
    },
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

const CLOCKS = new Map([
  [ACTING.id, { today: "2026-09-03", timeZone: "UTC" }],
  [MIA.id, { today: "2026-09-03", timeZone: "Pacific/Honolulu" }],
  [SAM.id, { today: "2026-09-04", timeZone: "Pacific/Kiritimati" }],
]);

function WithClocks({ children }: { children: React.ReactNode }) {
  return <ProfileDaysBoundary clocks={CLOCKS}>{children}</ProfileDaysBoundary>;
}

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
      <button onClick={() => open("food")}>open food</button>
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

// THE VISIT, where a subject switch has SIBLINGS to lose (#5624). Every case above
// drives the direct sheet, whose stack is one entry deep by construction, which is
// exactly why the loss never surfaced here.
function VisitSheet() {
  const visit = useQuickEntryVisit(true, () => {});
  return (
    <>
      <output data-testid="visit-view">{visit.active?.form ?? "menu"}</output>
      <button
        data-testid="visit-stool"
        onClick={(event) => visit.open("stool", event.currentTarget)}
      >
        Stool
      </button>
      <button
        data-testid="visit-mood"
        onClick={(event) => visit.open("mood", event.currentTarget)}
      >
        Mood
      </button>
      <button data-testid="visit-back" onClick={visit.back}>
        Back
      </button>
      {visit.titleAdornment}
      {visit.belowTitle}
      <QuickEntryVisitBodies identity={visit.identity} onDone={() => {}} />
    </>
  );
}

function renderVisit(writableProfiles: SessionProfile[]) {
  return render(
    <WithClocks>
      <ToastProvider>
        <QuickEntryProvider
          measurements={MEASUREMENTS}
          writableProfiles={writableProfiles}
          actingProfileId={ACTING.id}
        >
          <VisitSheet />
        </QuickEntryProvider>
      </ToastProvider>
    </WithClocks>
  );
}

const bodyFor = (form: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="quick-entry-body"][data-form="${form}"]`
  );

function renderSheet(writableProfiles: SessionProfile[]) {
  return render(
    <WithClocks>
      <ToastProvider>
        <QuickEntryProvider
          measurements={MEASUREMENTS}
          writableProfiles={writableProfiles}
          actingProfileId={ACTING.id}
        >
          <Opener />
        </QuickEntryProvider>
      </ToastProvider>
    </WithClocks>
  );
}

describe("the quick-log sheet's subject chip (#4932)", () => {
  it("keeps the host title visible for food", async () => {
    renderSheet([ACTING]);
    fireEvent.click(screen.getByText("open food"));
    expect(
      await screen.findByRole("heading", { name: "Log food" })
    ).toBeTruthy();
  });

  it("captures a dated route at the opener boundary", async () => {
    render(
      <WithClocks>
        <DayContextProvider
          profileId={ACTING.id}
          today="2026-09-07"
          reach={{ kind: "dated" }}
          backing={{
            kind: "url",
            day: "2026-08-20",
            hrefForDay: (day) => `/history?day=${day}` as AppRoute,
          }}
        >
          <ToastProvider>
            <QuickEntryProvider
              measurements={MEASUREMENTS}
              writableProfiles={[ACTING]}
              actingProfileId={ACTING.id}
            >
              <Opener />
            </QuickEntryProvider>
          </ToastProvider>
        </DayContextProvider>
      </WithClocks>
    );

    fireEvent.click(screen.getByText("open food"));
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "food",
        ACTING.id,
        "2026-08-20",
        "dated"
      )
    );
    expect(screen.queryByTestId("bounded-day-switcher")).toBeNull();
  });

  it("defaults to the opener's subject when one is passed", async () => {
    renderSheet([ACTING, MIA, SAM]);
    fireEvent.click(screen.getByText("open for Mia"));

    const chip = await screen.findByTestId("quick-entry-subject-chip");
    expect(chip.textContent).toContain("Mia");
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        MIA.id,
        undefined,
        "sheet"
      )
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
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        ACTING.id,
        undefined,
        "sheet"
      )
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
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        ACTING.id,
        undefined,
        "sheet"
      )
    );

    const bodyBefore = screen.getByTestId("quick-entry-body");
    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId(`quick-entry-subject-option-${SAM.id}`));

    // The block collapsed, the chip now names Sam, and the gather re-ran FOR Sam —
    // one gate, the SAME reader, just a different subject argument.
    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
    expect(chip.textContent).toContain("Sam");
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        SAM.id,
        undefined,
        "sheet"
      )
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
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        ACTING.id,
        undefined,
        "sheet"
      )
    );
    loadQuickEntry.mockClear();

    fireEvent.click(chip);
    fireEvent.click(
      screen.getByTestId(`quick-entry-subject-option-${ACTING.id}`)
    );

    expect(screen.queryByTestId("quick-entry-subject-picker")).toBeNull();
    expect(loadQuickEntry).not.toHaveBeenCalled();
  });

  it("switching the subject on one form keeps the visit's other drafts (#5624)", async () => {
    renderVisit([ACTING, MIA, SAM]);

    fireEvent.click(screen.getByTestId("visit-stool"));
    await waitFor(() => expect(bodyFor("stool")).not.toBeNull());
    const stoolBody = bodyFor("stool")!;
    fireEvent.click(screen.getByTestId("visit-back"));

    fireEvent.click(screen.getByTestId("visit-mood"));
    await waitFor(() => expect(bodyFor("mood")).not.toBeNull());

    fireEvent.click(screen.getByTestId("quick-entry-subject-chip"));
    fireEvent.click(screen.getByTestId(`quick-entry-subject-option-${MIA.id}`));

    // The switched form reloaded for Mia...
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "mood",
        MIA.id,
        undefined,
        "sheet"
      )
    );
    // ...and the Stool draft opened before it is the SAME mounted body, still for
    // Dad — not a fresh one, which is what a remount of the whole visit would give.
    expect(bodyFor("stool")).toBe(stoolBody);
    expect(stoolBody.getAttribute("data-subject-profile-id")).toBe(
      String(ACTING.id)
    );
    // And it is still reachable from the menu, without a third gather.
    fireEvent.click(screen.getByTestId("visit-back"));
    fireEvent.click(screen.getByTestId("visit-stool"));
    expect(screen.getByTestId("visit-view").textContent).toBe("stool");
    expect(bodyFor("stool")).toBe(stoolBody);
  });

  it("measurements renders unavailable for a chosen non-acting subject (#4091's gather has no per-subject version)", async () => {
    render(
      <WithClocks>
        <ToastProvider>
          <QuickEntryProvider
            measurements={MEASUREMENTS}
            writableProfiles={[ACTING, MIA]}
            actingProfileId={ACTING.id}
          >
            <OpenMeasurementsFor subjectId={MIA.id} />
          </QuickEntryProvider>
        </ToastProvider>
      </WithClocks>
    );
    fireEvent.click(screen.getByText("open measurements"));
    const unavailable = await screen.findByTestId("quick-entry-unavailable");
    expect(unavailable.textContent).toContain("Switch to this profile");
  });
});

// #5756 — THE INSTRUMENT'S OWN VOCABULARY, WHERE A PERSON PICKS A TYPE. Each stool
// tile carries its type's sentence as an accessible name and prints two words, so the
// one surface where somebody chooses a type showed pictures and the sentence that says
// what a picture means was reachable only after the fact, on another page, or through
// a screen reader. The title row's info glyph is where the sheet says it — the design
// system's existing "short explanation" row, in the `titleAdornment` slot the host
// already passes — and its label is BUILT from the vocabulary, so the tiles, the
// record's select and the glyph cannot come to disagree.
describe("the stool body states the scale it is asking about (#5756)", () => {
  it("opens the seven lines, and no other body carries a glyph", async () => {
    renderVisit([ACTING]);
    // The menu has no form and therefore no instrument — the absence below is a body
    // choosing not to explain itself, not a glyph that never renders anywhere.
    expect(screen.queryByTestId("quick-entry-help")).toBeNull();

    fireEvent.click(screen.getByTestId("visit-stool"));
    const glyph = await screen.findByTestId("quick-entry-help");
    // BEFORE THE SUBJECT CHIP, which is the order a reader meets them: what this
    // instrument is, then who it is being used for.
    expect(
      glyph.compareDocumentPosition(
        screen.getByTestId("quick-entry-subject-chip")
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(glyph);
    // Seven lines, each `<n> <label> — <description>`, compared against the vocabulary
    // itself rather than against seven retyped sentences: retyping them here would be
    // the fourth copy this glyph exists to avoid.
    expect(screen.getByRole("tooltip").textContent!.split("\n")).toEqual(
      BRISTOL_STOOL_TYPES.map((t) => `${t.type} ${t.label} — ${t.description}`)
    );

    fireEvent.click(screen.getByTestId("visit-mood"));
    await waitFor(() =>
      expect(screen.getByTestId("visit-view").textContent).toBe("mood")
    );
    expect(screen.queryByTestId("quick-entry-help")).toBeNull();
  });
});
