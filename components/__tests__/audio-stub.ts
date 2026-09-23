import { vi } from "vitest";

// A stubbed `AudioContext` that records the tones the app ASKED FOR (#5900), shared
// by the timer and toast-provider tests. No headless environment has a speaker.
// `failure` makes construction throw or `resume()` reject, the two ways a real
// browser refuses audio.
export function stubAudio(failure?: "construct" | "resume") {
  const start = vi.fn();
  const tones: number[] = [];
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
        const frequency = { value: 0 };
        return {
          type: "sine",
          frequency,
          connect: (gain: unknown) => gain,
          start: () => {
            tones.push(frequency.value);
            start();
          },
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
  return { start, resume, tones };
}
