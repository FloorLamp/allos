import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";

// THE MEASUREMENTS FORM'S SUBJECT SIGNAL (#4932 postmortem).
//
// `MeasurementsQuickAdd` carries TWO profile-shaped props that answer different
// questions. `profileId` scopes the last-written-group MEMORY (#2014) and is
// present on every mount, including an ordinary acting-profile one. `subjectProfileId`
// is the WRITE signal: present only when the quick-log sheet's chosen subject
// differs from the acting profile. #4932's subject chip read `profileId` for the
// write signal at all three sites this file exercises — the stamp, the offline
// refusal, and the catch-path fallback — so the offline refusal fired on every
// mount (`profileId` is never null) and broke the acting profile's own #4091
// offline weigh-in.
//
// This is the one direct mount of the form with a subject, matching the pattern
// its five siblings already use (dose/symptom/substance/mood/practice-two-pieces).
// Before this file, nothing in the shipped suite constructed a non-acting-subject
// write OR refusal for this component — confirmed by reverting the split back onto
// `profileId` and watching this file, and only this file, catch it. Worth keeping
// past today: the moment #4932's deferred "Default" clause wires a real opener
// (the dashboard cockpit action, the protocol row, the trends panel) to pass a
// subject, a caregiver reaches this exact component with one, and this is what
// stands guard.

const SUBJECT = 42;
// The mount's `profileId` — present on EVERY call below, subject or not, because
// that is how the sheet actually mounts this form (`measurementsQuickEntry`'s
// `profileId` is the acting profile, spread into every mount regardless of the
// chosen subject). Deliberately a different number than `SUBJECT`: a mutation
// that swaps the write signal back onto `profileId` must be caught by these
// tests actually disagreeing, not by one of the two fields happening to be unset.
const ACTING = 7;

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async () => "kept" as const),
}));

vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: async (fd: FormData) => {
    record("addMeasurements")(fd);
    return {};
  },
}));
const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: mocks.enqueue }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

// `onLine` lives on Navigator.PROTOTYPE (the note practice-two-pieces.test.tsx
// pins this same way): there is no own descriptor to put back, so the restore is
// a DELETE, not a re-assign — getting that wrong leaves every later test in this
// file, or the next file vitest happens to run in this worker, running offline.
function setOnline(value: boolean): () => void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
  return () => Reflect.deleteProperty(window.navigator, "onLine");
}

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  toasts.length = 0;
  mocks.enqueue.mockClear();
  mocks.enqueue.mockResolvedValue("kept");
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  cleanup();
});

async function weighIn(subjectProfileId?: number): Promise<void> {
  render(
    <MeasurementsQuickAdd
      defaultDate="2026-05-20"
      weightUnit="kg"
      defaultGroup="body"
      profileId={ACTING}
      subjectProfileId={subjectProfileId}
    />
  );
  fireEvent.change(screen.getByLabelText("Weight"), {
    target: { value: "80" },
  });
  await act(async () =>
    fireEvent.submit(screen.getByTestId("measurements-quick-add"))
  );
}

describe("the measurements form's subject signal (#4932 postmortem)", () => {
  it("stamps profile_id for a non-acting subject, and nothing for the acting profile", async () => {
    await weighIn(SUBJECT);
    expect(posted.addMeasurements).toHaveLength(1);
    expect(posted.addMeasurements[0].get("profile_id")).toBe(String(SUBJECT));

    cleanup();
    for (const key of Object.keys(posted)) delete posted[key];
    await weighIn(undefined);
    expect(posted.addMeasurements).toHaveLength(1);
    expect(posted.addMeasurements[0].get("profile_id")).toBeNull();
  });

  it("refuses offline for a non-acting subject, and queues nothing", async () => {
    const restore = setOnline(false);
    try {
      await weighIn(SUBJECT);
      expect(
        screen.getByText(
          "You're offline — reconnect to save these measurements."
        )
      ).toBeTruthy();
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(posted.addMeasurements).toBeUndefined();
      expect(toasts).toEqual([]);
    } finally {
      restore();
    }
  });

  // THE CONVERSE. "Never queues for a subject" would also be satisfied by a form
  // that had lost offline capture entirely — with no subject the same weigh-in
  // must still queue, exactly as #4091 built it to.
  it("still queues the acting profile's own offline weigh-in", async () => {
    const restore = setOnline(false);
    try {
      await weighIn(undefined);
      expect(mocks.enqueue).toHaveBeenCalledWith(
        "body-metric",
        "2026-05-20",
        expect.objectContaining({ weight: "80" })
      );
      expect(posted.addMeasurements).toBeUndefined();
      expect(toasts).toEqual(["Saved offline — will sync when you reconnect."]);
    } finally {
      restore();
    }
  });
});
