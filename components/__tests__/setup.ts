// Per-test hygiene for the component tier (#3446). Registered by the `components`
// project in vitest.config.ts; see that file for why the tier exists, why it shares
// this config, and why the environment is jsdom.
//
// The project runs ISOLATED, so every FILE starts with a fresh document. What this
// adds is the between-TESTS reset inside one file, which is where a DOM tier leaks:
// a stray element or a leftover storage key from the test above decides the verdict
// below, and it decides it toward green, because the assertions that matter here are
// mostly about a page NOT declaring something.
//
// Deliberately environment-only. The app's own module-level registries
// (lib/offline/unsaved-work.ts, components/update-reload-channel.ts) both publish a
// reset seam, but resetting them here would import them into every file in the tier
// whether or not it uses them — so each test file resets what it drives.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  // Unmount anything render()/renderHook() left mounted. This tier does NOT set
  // vitest's `globals`, so testing-library's own auto-cleanup never registers —
  // without this line every mounted hook keeps its listeners and its interval.
  cleanup();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});
