import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestTimer from "@/components/activity-form/RestTimer";
import FitnessTestTimer from "@/components/activity-form/FitnessTestTimer";
import LiveWorkoutPanel from "@/components/activity-form/LiveWorkoutPanel";
import { HAPTIC_PATTERNS } from "@/lib/haptics";

const editor = vi.hoisted(() => ({ subjectName: undefined, minimized: false }));
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => editor,
}));

const T0 = Date.UTC(2026, 8, 9, 12);

function stubRestBrowser(initial: NotificationPermission = "default") {
  let permission = initial;
  const requestPermission = vi.fn(async () => permission);
  const postMessage = vi.fn();
  const registration: {
    active: { state: string; postMessage: typeof postMessage } | null;
  } = {
    active: { state: "activated", postMessage },
  };
  const serviceWorker = Object.assign(new EventTarget(), {
    getRegistration: vi.fn(
      async (): Promise<typeof registration | undefined> => registration
    ),
  });
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  vi.stubGlobal("isSecureContext", true);
  Object.assign(navigator, { serviceWorker });
  return {
    requestPermission,
    postMessage,
    registration,
    serviceWorker,
    setPermission: (next: NotificationPermission) => {
      permission = next;
    },
  };
}

function panel() {
  return render(
    <LiveWorkoutPanel
      leadExercise="Barbell Bench Press"
      restStartKey={0}
      onFinish={vi.fn()}
    />
  );
}

async function refreshNotificationRow() {
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
  });
}

function stubAudio(failure?: "construct" | "resume") {
  const start = vi.fn();
  const resume = vi.fn(() =>
    failure === "resume"
      ? Promise.reject(new Error("Audio resume denied"))
      : Promise.resolve()
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      destination = {};
      resume = resume;
      constructor() {
        if (failure === "construct") throw new Error("Audio unavailable");
      }
      createOscillator() {
        return {
          type: "sine",
          frequency: { value: 0 },
          connect: (gain: unknown) => gain,
          start,
          stop: vi.fn(),
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
      }
    }
  );
  return { start, resume };
}

function startRest() {
  render(<RestTimer exercise="Barbell Bench Press" autoStartKey={0} />);
  fireEvent.click(screen.getByRole("button", { name: "1:30" }));
  fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
}

describe("activity timer completion", () => {
  const vibrate = vi.fn(() => true);

  beforeEach(() => {
    editor.minimized = false;
    // `now: T0` ANCHORS THE FAKE CLOCK AT INSTALL, and it has to: the fake
    // `requestAnimationFrame` puts the next frame on a 16ms grid measured from
    // the epoch the clock was installed at, so installing at the real time and
    // only then moving to T0 leaves the grid offset by whatever the real clock
    // read. Once real time passed T0 that offset made the pending frame land
    // 17-31ms out, and the Fitness case below — which advances one 16ms frame —
    // stopped reaching it (#5631). Anchored here, the frame is exactly 16ms
    // away for every run, today and in a year.
    vi.useFakeTimers({
      now: T0,
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vibrate.mockClear();
    vi.stubGlobal("navigator", { vibrate });
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["tick", "visibility"] as const)(
    "a %s wake reads the deadline after suppressed callbacks and cues once",
    (wake) => {
      const audio = stubAudio();
      startRest();
      const readout = screen.getByTestId("rest-remaining");
      const repaint = () => {
        if (wake === "tick") vi.advanceTimersByTime(1000);
        else fireEvent(document, new Event("visibilitychange"));
      };

      // setSystemTime moves wall time without running the missed interval callbacks.
      act(() => vi.setSystemTime(T0 + 30_000));
      expect(readout.textContent).toBe("1:30");
      act(repaint);
      expect(readout.textContent).toBe(wake === "tick" ? "0:59" : "1:00");
      expect(audio.start).not.toHaveBeenCalled();

      act(() => {
        vi.setSystemTime(T0 + 95_000);
        repaint();
      });
      expect(readout.textContent).toBe("Rest done");
      expect(
        screen.getByRole("button", { name: "Start rest timer" })
      ).toBeTruthy();
      act(() => {
        fireEvent(document, new Event("visibilitychange"));
        vi.advanceTimersByTime(1000);
      });
      expect(audio.start).toHaveBeenCalledTimes(1);
      expect(vibrate.mock.calls).toEqual([[[...HAPTIC_PATTERNS.alert]]]);
    }
  );

  it("nudges unpainted remaining time, pauses it, restarts the target and cancels on Reset", () => {
    const audio = stubAudio();
    startRest();
    const readout = screen.getByTestId("rest-remaining");
    act(() => vi.setSystemTime(T0 + 30_000));
    fireEvent.click(screen.getByRole("button", { name: "Add 15 seconds" }));
    expect(readout.textContent).toBe("1:15");

    act(() => vi.setSystemTime(T0 + 40_000));
    fireEvent.click(screen.getByRole("button", { name: "Pause rest timer" }));
    expect(readout.textContent).toBe("1:05");
    act(() => {
      vi.setSystemTime(T0 + 200_000);
      vi.advanceTimersByTime(1000);
    });
    expect(readout.textContent).toBe("1:05");
    fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
    expect(readout.textContent).toBe("1:30");
    fireEvent.click(screen.getByRole("button", { name: "Reset rest timer" }));
    act(() => {
      vi.setSystemTime(T0 + 400_000);
      vi.advanceTimersByTime(1000);
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(readout.textContent).toBe("1:30");
    expect(
      screen.getByRole("button", { name: "Start rest timer" })
    ).toBeTruthy();
    expect(audio.start).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("still completes rest and requests a haptic when audio construction fails", () => {
    stubAudio("construct");
    startRest();
    act(() => {
      vi.setSystemTime(T0 + 95_000);
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(screen.getByTestId("rest-remaining").textContent).toBe("Rest done");
    expect(vibrate.mock.calls).toEqual([[[...HAPTIC_PATTERNS.alert]]]);
  });

  it("still finishes Fitness once when audio resume rejects", async () => {
    const audio = stubAudio("resume");
    const finish = vi.fn();
    render(
      <FitnessTestTimer
        label="Chair stand"
        testKey="chair-stand"
        window={1}
        onFinish={finish}
      />
    );
    fireEvent.click(screen.getByTestId("fitness-timer-chair-stand-launch"));
    fireEvent.click(screen.getByTestId("fitness-timer-chair-stand-start"));
    await act(async () => {
      vi.setSystemTime(T0 + 1500);
      vi.advanceTimersByTime(16);
    });
    expect(screen.queryByTestId("fitness-timer-chair-stand-panel")).toBeNull();
    expect(finish.mock.calls).toEqual([[1]]);
    expect(audio.resume).toHaveBeenCalledTimes(1);
    expect(vibrate.mock.calls).toEqual([[[...HAPTIC_PATTERNS.alert]]]);
  });

  it.each(["default", "denied"] as const)(
    "remembers a %s permission outcome through remount, Disable and permission reset",
    async (outcome) => {
      const browser = stubRestBrowser();
      browser.requestPermission.mockImplementation(async () => {
        browser.setPermission(outcome);
        return outcome;
      });
      let view = panel();
      await refreshNotificationRow();
      fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
      expect(browser.requestPermission).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Enable rest notifications" })
        );
      });
      expect(browser.requestPermission).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status").textContent).toContain(
        "browser settings"
      );
      view.unmount();
      browser.setPermission("default");
      view = panel();
      await refreshNotificationRow();
      expect(
        (
          screen.getByRole("button", {
            name: "Enable rest notifications",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      browser.setPermission("granted");
      await refreshNotificationRow();
      fireEvent.click(
        screen.getByRole("button", { name: "Enable rest notifications" })
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Disable rest notifications" })
      );
      view.unmount();
      browser.setPermission("default");
      panel();
      await refreshNotificationRow();
      expect(
        (
          screen.getByRole("button", {
            name: "Enable rest notifications",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    "visible",
    "hidden",
    "no consent",
    "revoked",
    "no worker",
    "dispatch failed",
  ] as const)(
    "completes a %s rest once using the current delivery conditions",
    async (condition) => {
      const audio = stubAudio();
      const browser = stubRestBrowser("granted");
      // Minimized is deliberately separate from document visibility.
      editor.minimized = true;
      panel();
      await refreshNotificationRow();
      expect(
        screen.getByRole("button", { name: "Enable rest notifications" })
      ).toBeTruthy();
      if (condition !== "no consent")
        fireEvent.click(
          screen.getByRole("button", { name: "Enable rest notifications" })
        );
      fireEvent.click(screen.getByRole("button", { name: "1:30" }));
      fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
      if (condition === "revoked") browser.setPermission("denied");
      if (condition === "no worker") browser.registration.active = null;
      if (condition === "dispatch failed")
        browser.postMessage.mockImplementation(() => {
          throw new Error("Worker stopped");
        });
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(
        condition === "visible" ? "visible" : "hidden"
      );
      act(() => {
        vi.setSystemTime(T0 + 95_000);
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("rest-remaining").textContent).toBe(
        "Rest done"
      );
      const attempts =
        condition === "hidden" || condition === "dispatch failed" ? 1 : 0;
      // Only a notification the worker took replaces the page-side cue; every
      // undeliverable condition still chimes and vibrates exactly as before.
      const cues = condition === "hidden" ? 0 : 1;
      expect(browser.postMessage.mock.calls).toEqual(
        attempts ? [[{ type: "allos-rest-done" }]] : []
      );
      expect(audio.start).toHaveBeenCalledTimes(cues);
      expect(vibrate).toHaveBeenCalledTimes(cues);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await refreshNotificationRow();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(browser.postMessage).toHaveBeenCalledTimes(attempts);
      expect(audio.start).toHaveBeenCalledTimes(cues);
      expect(browser.requestPermission).not.toHaveBeenCalled();
    }
  );

  it.each(["kept", "removed"] as const)(
    "resolves a pending grant with consent %s during the prompt",
    async (consent) => {
      const browser = stubRestBrowser();
      let grant!: (permission: NotificationPermission) => void;
      const pending = new Promise<NotificationPermission>((resolve) => {
        grant = resolve;
      });
      browser.requestPermission.mockReturnValue(pending);
      panel();
      await refreshNotificationRow();
      fireEvent.click(
        screen.getByRole("button", { name: "Enable rest notifications" })
      );
      expect(browser.requestPermission).toHaveBeenCalledOnce();
      // No storage event is needed: resolving permission must read durable consent.
      if (consent === "removed")
        localStorage.removeItem("allos-rest-notifications");
      await act(async () => {
        browser.setPermission("granted");
        grant("granted");
      });
      expect(screen.getByRole("status").textContent).toBe(
        consent === "kept" ? "On for this browser." : "Off for this browser."
      );
      fireEvent.click(screen.getByRole("button", { name: "1:30" }));
      fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => {
        vi.setSystemTime(T0 + 95_000);
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("rest-remaining").textContent).toBe(
        "Rest done"
      );
      expect(browser.postMessage.mock.calls).toEqual(
        consent === "kept" ? [[{ type: "allos-rest-done" }]] : []
      );
    }
  );

  it("uses durable consent and asked history changed by another tab before its storage event", async () => {
    const browser = stubRestBrowser();
    panel();
    await refreshNotificationRow();
    localStorage.setItem("allos-rest-notifications", "asked");
    fireEvent.click(
      screen.getByRole("button", { name: "Enable rest notifications" })
    );
    expect(browser.requestPermission).not.toHaveBeenCalled();
    browser.setPermission("granted");
    await refreshNotificationRow();
    fireEvent.click(
      screen.getByRole("button", { name: "Enable rest notifications" })
    );
    localStorage.setItem("allos-rest-notifications", "disabled");
    fireEvent.click(screen.getByRole("button", { name: "1:30" }));
    fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      vi.setSystemTime(T0 + 95_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("rest-remaining").textContent).toBe("Rest done");
    expect(browser.postMessage).not.toHaveBeenCalled();
  });

  it("keeps an explicit choice usable in this mount when saving it fails", async () => {
    const browser = stubRestBrowser("granted");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    panel();
    await refreshNotificationRow();
    fireEvent.click(
      screen.getByRole("button", { name: "Enable rest notifications" })
    );
    fireEvent.click(screen.getByRole("button", { name: "1:30" }));
    fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      vi.setSystemTime(T0 + 95_000);
      vi.advanceTimersByTime(1000);
    });
    expect(browser.postMessage).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Disable rest notifications" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
    act(() => {
      vi.setSystemTime(T0 + 190_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("rest-remaining").textContent).toBe("Rest done");
    expect(browser.postMessage).toHaveBeenCalledOnce();
  });

  it("does not queue a completed rest while registration is unavailable", async () => {
    const browser = stubRestBrowser("granted");
    browser.serviceWorker.getRegistration.mockResolvedValue(undefined);
    localStorage.setItem("allos-rest-notifications", "enabled");
    panel();
    await refreshNotificationRow();
    expect(screen.getByRole("status").textContent).toContain(
      "aren’t available"
    );
    fireEvent.click(screen.getByRole("button", { name: "1:30" }));
    fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      vi.setSystemTime(T0 + 95_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("rest-remaining").textContent).toBe("Rest done");
    browser.serviceWorker.getRegistration.mockResolvedValue(
      browser.registration
    );
    await act(async () => {
      browser.serviceWorker.dispatchEvent(new Event("controllerchange"));
    });
    expect(browser.postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start rest timer" }));
    act(() => {
      vi.setSystemTime(T0 + 190_000);
      vi.advanceTimersByTime(1000);
    });
    expect(browser.postMessage).toHaveBeenCalledOnce();
  });
});
