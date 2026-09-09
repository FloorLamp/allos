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
import { HAPTIC_PATTERNS } from "@/lib/haptics";

const T0 = Date.UTC(2026, 8, 9, 12);

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
    vi.useFakeTimers({
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
    vi.setSystemTime(T0);
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
});
