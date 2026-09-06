import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExertionOffer } from "@/lib/exertion-offer";

// THE FORM PREFILLS FROM THE EFFORT ITS HEART RATE FOUND (#5195, reader 2 of #5113),
// driven through the REAL ActivityForm.
//
// The three questions here are the ones no cheaper tier can answer, because all three
// are about the form's own state rather than about the reader behind it (that is the
// DB tier, lib/__db_tests__/exertion-offer.test.ts):
//
//   1. A form opened with no clocks of its own carries the span's, MARKED, with Adjust.
//   2. A form opened WITH clocks, or on a day with no span, is unchanged — and does not
//      even ask.
//   3. THE FIELD WINS. The offer arrives over the network, so a person can type a Start
//      before it lands; what they typed must survive it. That is criterion 3, and the
//      only honest way to state it is with the answer deliberately in flight.
//
// Every value is synthetic.

const offerCalls: string[] = [];
let pendingOffer: (value: ExertionOffer | null) => void;
let offerPromise: Promise<ExertionOffer | null>;

vi.mock("@/app/(app)/training/activity-actions", () => ({
  exertionPrefillOffer: vi.fn((date: string) => {
    offerCalls.push(date);
    return offerPromise;
  }),
  saveActivity: vi.fn(async () => ({ ok: true, id: 11 })),
  deleteActivity: vi.fn(async () => ({ undoId: null })),
  logBodyweight: vi.fn(async () => ({ ok: true })),
  setRpeTrackingAction: vi.fn(async () => null),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/training",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("../ConfirmDialog", () => ({
  useConfirm: () => vi.fn(async () => true),
}));

import ActivityForm from "../ActivityForm";
import { TimezoneProvider } from "../TimezoneProvider";

/** The profile's day in the fixture's zone — the date the form asks about. */
const TODAY = new Date().toISOString().slice(0, 10);

const OFFER: ExertionOffer = {
  start: "16:00",
  end: "16:35",
  dismissalKey: "exertion-span:2026-07-17T16:00",
};

const PROPS = {
  units: { weight: "kg", distance: "km", energy: "kcal" },
  suggestions: { lifts: [], cardio: [], sports: [], titles: [], logged: [] },
  history: {},
  equipment: [],
  bodyweightKg: 70,
  strengthTrainingAvailable: true,
  editData: null,
  deloadContext: { week: null, lifts: {} },
  onClose: () => {},
} as unknown as React.ComponentProps<typeof ActivityForm>;

function mount(extra: Partial<React.ComponentProps<typeof ActivityForm>> = {}) {
  return render(
    <TimezoneProvider tz="UTC">
      <ActivityForm {...PROPS} {...extra} />
    </TimezoneProvider>
  );
}

const startField = () =>
  document.getElementById("activity-start-time") as HTMLInputElement;
const endField = () =>
  document.getElementById("activity-end-time") as HTMLInputElement;

describe("the activity form's exertion prefill", () => {
  beforeEach(() => {
    offerCalls.length = 0;
    offerPromise = new Promise((resolve) => {
      pendingOffer = resolve;
    });
  });

  it("carries the span's clocks, marked, with Adjust beside them", async () => {
    mount();
    pendingOffer(OFFER);
    await waitFor(() => expect(startField().value).toBe("16:00"));
    expect(endField().value).toBe("16:35");
    // MARKED, because a value the person did not state has to say where it came from.
    const mark = await screen.findByTestId("times-from-heart-rate");
    expect(mark.textContent).toContain("From your heart rate");
    expect(screen.getByRole("button", { name: "Adjust" })).not.toBeNull();
  });

  it("leaves a form that was given clocks alone, and does not even ask", async () => {
    mount({ initialStartTime: "09:00", initialEndTime: "09:30" });
    pendingOffer(OFFER);
    await Promise.resolve();
    expect(offerCalls).toEqual([]);
    expect(startField().value).toBe("09:00");
    expect(endField().value).toBe("09:30");
    expect(screen.queryByTestId("times-from-heart-rate")).toBeNull();
  });

  it("leaves a day with no unclaimed span unchanged", async () => {
    mount();
    const openedWith = startField().value;
    pendingOffer(null);
    await waitFor(() => expect(offerCalls).toEqual([TODAY]));
    expect(startField().value).toBe(openedWith);
    expect(endField().value).toBe("");
    expect(screen.queryByTestId("times-from-heart-rate")).toBeNull();
  });

  it("keeps what the person typed while the answer was in flight", async () => {
    // CRITERION 3, stated where it can actually fail. The offer resolves AFTER the
    // typing, which is the ordinary case for a network answer — a form is usable the
    // moment it opens. What the field holds must survive the span landing.
    mount();
    fireEvent.change(startField(), { target: { value: "07:15" } });
    expect(startField().value).toBe("07:15");

    pendingOffer(OFFER);
    await waitFor(() => expect(offerCalls).toEqual([TODAY]));
    // A re-render after the answer must not put the span's minute back either.
    fireEvent.change(endField(), { target: { value: "08:00" } });
    expect(startField().value).toBe("07:15");
    expect(endField().value).toBe("08:00");
    expect(screen.queryByTestId("times-from-heart-rate")).toBeNull();
  });

  it("drops the mark once the person adjusts a prefilled clock", async () => {
    mount();
    pendingOffer(OFFER);
    await screen.findByTestId("times-from-heart-rate");
    fireEvent.change(startField(), { target: { value: "16:10" } });
    expect(startField().value).toBe("16:10");
    // The mark says where the clocks CAME FROM, so it cannot outlive their being
    // changed — a prefill that keeps claiming the heart rate said something the person
    // has since overwritten is the lie criterion 3 is about.
    expect(screen.queryByTestId("times-from-heart-rate")).toBeNull();
  });
});
