import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProfileMuteToggle from "@/app/(app)/settings/notifications/ProfileMuteToggle";
import RecommendationCadenceForm from "@/app/(app)/settings/profile/RecommendationCadenceForm";
import CrisisResourcesEditor from "@/components/CrisisResourcesEditor";
import PublicUrlSettings from "@/app/(app)/settings/PublicUrlSettings";
import NotificationPrefs from "@/app/(app)/settings/notifications/NotificationPrefs";
import { arrivalStatistics } from "@/lib/notifications/digest-schedule";
import { channelReadiness } from "@/lib/notifications/matrix-liveness";
import { isStaleActionError } from "@/lib/sw-update";

const saveProfileNotifyMute = vi.hoisted(() => vi.fn());
const saveLoginTelegramNotifyKinds = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/settings/actions", () => ({
  saveProfileNotifyMute,
  saveLoginTelegramNotifyKinds,
  savePushNotifyKinds: vi.fn(),
  saveLoginEmailNotifyKinds: vi.fn(),
}));

const saveRecommendationCadence = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/settings/profile/actions", () => ({
  saveRecommendationCadence,
  saveNotificationPrefs: vi.fn(),
  saveHomeAssistantNotifyKinds: vi.fn(),
}));

const savePublicUrl = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/settings/server/actions", () => ({ savePublicUrl }));

type Save = (fd: FormData) => Promise<void>;

interface Shape {
  name: string;
  /** Mount the real settings surface, wired to `save` as its server action. */
  mount: (save: Save) => void;
  /** The control's value as the person sees it. */
  read: () => string;
  /** Drive the control to `after` the way a person would, firing the save. */
  flip: () => void;
  before: string;
  after: string;
}

// The routing matrix with every channel set up and every kind routed, so any cell is a
// live tick a refused write has to take back (#4736).
function mountPrefs(save: Save): void {
  saveLoginTelegramNotifyKinds.mockImplementation(save);
  render(
    <NotificationPrefs
      schedule={{
        supplementMinutes: { Morning: 480, Midday: null, Evening: null, Bedtime: null },
        workoutEnabled: false,
        morningAuto: false,
        digestMinute: null,
        digestMode: "static",
        weeklyRecapDay: null,
        weeklyRecapMinute: null,
        recapScale: "week",
        milestonesEnabled: false,
        preventiveEnabled: false,
        wakingStartHour: 8,
        wakingEndHour: 21,
      }}
      workoutSummary=""
      trainingRelevant={false}
      foodTelegramEnabled={false}
      substanceTelegramEnabled={false}
      foodLoggingRelevant={false}
      moodCheckinEnabled={false}
      moodRecapEnabled={false}
      sleepDigestEnabled={false}
      wearReminderEnabled={false}
      wearReminderPaused={null}
      wakeMinute={null}
      arrivalStats={arrivalStatistics([])}
      timeSuggestion={null}
      tickMinutes={60}
      timeFormat="24h"
      subHourlyAtRisk={null}
      telegramDisabled={[]}
      pushDisabled={[]}
      haDisabled={[]}
      emailDisabled={[]}
      readiness={channelReadiness({
        telegramBotConfigured: true,
        telegramRecipient: true,
        pushSubscribed: true,
        haWebhook: true,
        smtpConfigured: true,
        emailRecipient: true,
      })}
      isAdmin={false}
      profileName="Robin"
    />
  );
}

// One surface per CONTROL SHAPE. `useSaveStatus` is the substrate under ~33 settings
// surfaces, so what these four do on a failed save is what all of them do; the shapes
// differ because a checkbox commits on change, a select on change, a text field on
// blur, and a routing cell writes ONE channel's whole column through that channel's own
// action (#4736 — the last control that kept a value it failed to save).
const SHAPES: Shape[] = [
  {
    name: "checkbox",
    mount: (save) => {
      saveProfileNotifyMute.mockImplementation(save);
      render(
        <ProfileMuteToggle
          profileId={7}
          profileName="Robin"
          muted={false}
          lastUnmutedManaging={false}
        />
      );
    },
    read: () =>
      String(
        (screen.getByTestId("profile-notify-mute") as HTMLInputElement).checked
      ),
    flip: () => fireEvent.click(screen.getByTestId("profile-notify-mute")),
    before: "false",
    after: "true",
  },
  {
    name: "select",
    mount: (save) => {
      saveRecommendationCadence.mockImplementation(save);
      render(<RecommendationCadenceForm cadence="weekly" isAdmin />);
    },
    read: () =>
      (screen.getByTestId("recommendation-cadence") as HTMLSelectElement).value,
    flip: () =>
      fireEvent.change(screen.getByTestId("recommendation-cadence"), {
        target: { value: "daily" },
      }),
    before: "weekly",
    after: "daily",
  },
  {
    name: "text",
    mount: (save) => {
      render(
        <CrisisResourcesEditor
          action={save}
          initialText="Old line | 000"
          title="Crisis resources"
          description="One per line."
        />
      );
    },
    read: () =>
      (screen.getByTestId("crisis-resources-input") as HTMLTextAreaElement)
        .value,
    flip: () => {
      const el = screen.getByTestId("crisis-resources-input");
      fireEvent.change(el, { target: { value: "New line | 111" } });
      fireEvent.blur(el);
    },
    before: "Old line | 000",
    after: "New line | 111",
  },
  {
    name: "routing cell",
    mount: mountPrefs,
    read: () =>
      String(
        (screen.getByTestId("matrix-cell-telegram-refill") as HTMLInputElement)
          .checked
      ),
    flip: () => fireEvent.click(screen.getByTestId("matrix-cell-telegram-refill")),
    before: "true",
    after: "false",
  },
];

function held() {
  let settle!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = () => resolve();
    fail = reject;
  });
  return { promise, settle, fail };
}

// #4688. Every settings surface used to hold the control's value in its own
// `useState` and paint it before the save, so a REFUSED write stayed on screen next
// to the error icon — the control said the profile was muted when it was not. The
// value now lives in `useSaveStatus`, which puts the last saved one back when the
// save throws, so the restore is structural rather than something 33 call sites each
// have to remember.
describe("a failed save takes back what it painted (#4688)", () => {
  it.each(SHAPES)(
    "$name: paints the destination value before the write answers",
    async ({ mount, read, flip, before, after }) => {
      const write = held();
      mount(() => write.promise);
      expect(read()).toBe(before);

      flip();
      // The tap is acknowledged in the same frame — the rollback must not be bought
      // by making the control wait for the round trip (#2641).
      await waitFor(() => expect(read()).toBe(after));

      write.settle();
      await waitFor(() => expect(read()).toBe(after));
    }
  );

  it.each(SHAPES)(
    "$name: puts the prior value back when the write throws, and still says so",
    async ({ mount, read, flip, before, after }) => {
      const write = held();
      mount(() => write.promise);

      flip();
      await waitFor(() => expect(read()).toBe(after));

      write.fail(new Error("nope"));
      // Both halves of the claim are awaited TOGETHER (#4747). The failure stays
      // VISIBLE — reverting silently would trade one lie for a different confusion —
      // but the restore and the error flag are set in one transition whose `pending`
      // clears a commit later, and `SaveStatus` renders the spinner in preference to
      // the error icon while it is true. Read outside this `waitFor`, the icon
      // assertion can land on that in-between commit.
      await waitFor(() => {
        expect(read()).toBe(before);
        expect(screen.getByLabelText("Couldn’t save")).toBeTruthy();
      });
    }
  );

  it("a refused routing write is caught — never an unhandled rejection (#4736)", async () => {
    // The routing matrix used to `await saver[channel](fd)` inside its onChange with
    // no catch, so a refused column write escaped the handler entirely. vitest fails
    // a run on an unhandled rejection anyway; this listener makes the claim explicit
    // and local, so the test names the defect instead of the runner naming it.
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onEscape);
    try {
      const write = held();
      const cell = SHAPES[3];
      cell.mount(() => write.promise);
      cell.flip();
      await waitFor(() => expect(cell.read()).toBe(cell.after));
      write.fail(new Error("nope"));
      await waitFor(() => expect(cell.read()).toBe(cell.before));
      // Let any orphaned rejection reach the process before counting.
      await new Promise((r) => setTimeout(r, 0));
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", onEscape);
    }
  });

  it("rolls back a stale-action failure, whose classification it leaves alone", async () => {
    // The deploy-skew case is the one where a painted value must NOT survive: this
    // build's action ids are gone, so nothing was written and no retry can write it.
    // The hook must not swallow the signature either — `isStaleActionError` reads the
    // same error the save threw.
    const stale = new Error(
      "Failed to find Server Action. This request might be from an older or newer deployment."
    );
    expect(isStaleActionError(stale)).toBe(true);

    const write = held();
    const [checkbox] = SHAPES;
    checkbox.mount(() => write.promise);

    checkbox.flip();
    await waitFor(() => expect(checkbox.read()).toBe(checkbox.after));

    write.fail(stale);
    await waitFor(() => {
      expect(checkbox.read()).toBe(checkbox.before);
      expect(screen.getByLabelText("Couldn’t save")).toBeTruthy();
    });
    expect(isStaleActionError(stale)).toBe(true);
  });

  // A REFUSAL IS NOT A FAILURE, and the difference is what the person keeps. Both
  // store nothing and both show the error icon — but a throw means the painted value
  // is a claim the server never accepted, while a typed refusal is the app telling
  // someone to fix the draft they have not sent yet. Taking that draft away deletes
  // their work; on the Home Assistant card it also un-ticks Enable and hides the very
  // field they were told to correct, which is how e2e/home-assistant-notify.spec.ts
  // found this. Both directions here, because a test for only the first would pass on
  // a hook that had simply stopped rolling back.
  it.each([
    { outcome: "refuses", answer: { ok: false, error: "Enter a valid URL." } },
    { outcome: "throws", answer: new Error("nope") },
  ])(
    "a save that $outcome keeps the error, and only a throw reverts",
    async ({ outcome, answer }) => {
      const refused = outcome === "refuses";
      savePublicUrl.mockImplementation(async () => {
        if (!refused) throw answer;
        return answer;
      });
      render(<PublicUrlSettings publicUrl="https://old.example" />);
      const field = screen.getByPlaceholderText("https://your-app.example.com");

      fireEvent.change(field, { target: { value: "not-a-url" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(screen.getByLabelText("Couldn\u2019t save")).toBeTruthy()
      );
      expect((field as HTMLInputElement).value).toBe(
        refused ? "not-a-url" : "https://old.example"
      );
    }
  );
});
