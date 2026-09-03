import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabeledVerbChip } from "@/components/Chip";
import OfferRow from "@/components/OfferRow";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";

const logAdministration = vi.hoisted(() =>
  vi.fn(async (_formData: FormData) => ({
    ok: true as const,
    outcome: "logged" as const,
  }))
);
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
// The shared ledger stands in, but its `tap` RUNS the write — a stubbed one would make
// every assertion about what a tap posts pass vacuously.
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: async <T,>(op: {
      write: () => Promise<T>;
      settle: (outcome: T) => unknown;
    }) => op.settle(await op.write()),
  }),
}));
vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration: logAdministration,
}));

afterEach(() => {
  cleanup();
  logAdministration.mockClear();
});

// The primitive's four claims (#4753): the label carries the payload, the whole pill
// is ONE control-box target, the verb nub is not a second tab stop, and the clock door
// renders in its seat only when an adopter passes one.

function mount(props: Partial<Parameters<typeof LabeledVerbChip>[0]> = {}) {
  const onAct = vi.fn();
  render(
    <LabeledVerbChip
      label="Aug 30 · 250 mg"
      verb="Log"
      tone="neutral"
      onAct={onAct}
      {...props}
    />
  );
  return { onAct };
}

describe("LabeledVerbChip", () => {
  it("is one pressable box wearing the chip control box, label then verb", () => {
    mount();
    const pills = screen.getAllByRole("button");
    expect(pills).toHaveLength(1);
    const pill = pills[0]!;
    // The name a reader hears is the payload AND the verb, composed from the pill's
    // own text — no aria-label restates it, so the two cannot drift apart.
    expect(pill.textContent).toBe("Aug 30 · 250 mgLog");
    expect(pill.getAttribute("aria-label")).toBeNull();
    expect(pill.className).toBe("chip-base chip-offer");
    fireEvent.click(pill);
  });

  it("reports the tap once from anywhere in the pill, label included", () => {
    const { onAct } = mount();
    fireEvent.click(screen.getByText("Aug 30 · 250 mg"));
    expect(onAct).toHaveBeenCalledTimes(1);
  });

  it.each([
    // Tone is DECLARED, and the verb nub is where it lands (#4548's ruling).
    ["brand", "bg-brand-600"],
    ["neutral", "bg-slate-200"],
  ] as const)("paints a %s verb from the offer substrate", (tone, fill) => {
    mount({ tone });
    expect(screen.getByText("Log").className).toContain(fill);
  });

  it.each([
    // [clock door passed, seats rendered]
    [undefined, 0],
    [<span key="door" data-testid="door" />, 1],
  ])("renders the clock door only in its seat (%#)", (door, seats) => {
    mount({ clockDoor: door });
    expect(screen.queryAllByTestId("door")).toHaveLength(seats);
    // And nothing else joins the tab sequence: the nub is a span, and a seated door
    // is the adopter's own control rather than a second half of this one.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the whole pill one tab stop with the verb inside it", () => {
    mount();
    const pill = screen.getByRole("button");
    const verb = screen.getByText("Log");
    expect(pill.contains(verb)).toBe(true);
    expect(verb.tagName).toBe("SPAN");
    expect(verb.getAttribute("tabindex")).toBeNull();
  });
});

describe("OfferRow", () => {
  it.each([
    ["brand", "bg-brand-50/60"],
    ["neutral", "bg-surface"],
  ] as const)(
    "declares its %s tone and keeps the caller's margin",
    (tone, fill) => {
      const onAct = vi.fn();
      render(
        <OfferRow tone={tone} onAct={onAct} testId="offer" className="mb-3">
          Your usual Morning (3)
        </OfferRow>
      );
      const row = screen.getByTestId("offer");
      expect(row.className).toContain(fill);
      expect(row.className).toContain("mb-3");
      fireEvent.click(row);
      expect(onAct).toHaveBeenCalledTimes(1);
    }
  );
});

// ── THE FIRST ADOPTER (#4753) ───────────────────────────────────────────────
//
// The PRN row is where "Taken now" lived, and it is the only shipped surface that
// renders a real clock door beside its one-tap — so it is where the seat above stops
// being a reserved path and becomes a mounted one. Both arms are asserted, because the
// adoption's honesty is in what it did NOT take: `compactActions` keeps the icon-only
// shape it shipped with (#4753's open question 3 is the owner's), and only the COPY
// migration the issue settles outright reaches it.
function prnRow(props: { compactActions?: boolean } = {}) {
  render(
    <QuickLogPrnControl
      itemId={31}
      name="Ibuprofen"
      doseAmount="200 mg"
      dayLabel="1 today · last 4:02pm"
      tz="UTC"
      {...props}
    />
  );
}

describe("the PRN row adopts the labeled-verb chip (#4753)", () => {
  it("draws the payload and a one-word verb, with the clock door in its seat", () => {
    prnRow();
    const pill = screen.getByTestId("prn-log-now");
    expect(pill.className).toBe("chip-base chip-offer");
    // The label is what the tap WRITES; the verb is one word and never says "now".
    expect(pill.textContent).toBe("200 mgTake");
    // The seat is a real sibling of the pill, not a second target inside it: the door
    // is the row's own control and keeps its own name.
    expect(pill.contains(screen.getByTestId("prn-log-when-toggle"))).toBe(false);
    expect(pill.parentElement?.className).toContain("gap-3");
    expect(pill.parentElement).toBe(
      screen.getByTestId("prn-log-when-toggle").parentElement
    );
  });

  it("logs the administration from a tap on the label", async () => {
    prnRow();
    await act(async () => fireEvent.click(screen.getByText("200 mg")));
    expect(logAdministration).toHaveBeenCalledTimes(1);
    const posted = logAdministration.mock.calls[0]![0];
    expect(posted.get("id")).toBe("31");
    expect(posted.get("offset")).toBe("now");
    // A now-tap states no time, so the post is the one it always was.
    expect(posted.get("time")).toBeNull();
  });

  it("leaves the icon-only arm the shape it shipped with, minus the retired copy", () => {
    prnRow({ compactActions: true });
    const take = screen.getByTestId("prn-log-now");
    expect(take.className).not.toContain("chip-offer");
    expect(take.querySelector("span")?.className).toContain("sr-only");
    // ONE sentence for both arms: the icon button speaks what the pill composes.
    expect(take.getAttribute("aria-label")).toBe("Take Ibuprofen · 200 mg");
  });

  it("names the medication when it carries no recorded dose", () => {
    render(
      <QuickLogPrnControl
        itemId={31}
        name="Ibuprofen"
        dayLabel="None today"
        tz="UTC"
      />
    );
    expect(screen.getByTestId("prn-log-now").textContent).toBe("IbuprofenTake");
  });
});
