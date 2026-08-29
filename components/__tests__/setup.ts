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

// jsdom SHIPS NO `matchMedia`, and the app reads it wherever a preference is a media
// query: `usePrefersReducedMotion` (#1307) and `useStandaloneDisplayMode` both call it
// during render, so any component that consults one throws "not a function" before its
// first assertion. The gap surfaced when haptics mounted on the shared substrates
// (#3699) and SegmentedControl gained the hook — four unrelated files went red at once,
// none of them about the thing they test.
//
// The stand-in answers NO to every query, which is the same default the app's own SSR
// snapshot uses, so a test that says nothing about a preference gets the ordinary
// branch. A test that means to drive the OTHER branch stubs `matchMedia` itself, and
// its stub replaces this one.
if (typeof window !== "undefined" && !window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

afterEach(() => {
  // Unmount anything render()/renderHook() left mounted. This tier does NOT set
  // vitest's `globals`, so testing-library's own auto-cleanup never registers —
  // without this line every mounted hook keeps its listeners and its interval.
  cleanup();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});
