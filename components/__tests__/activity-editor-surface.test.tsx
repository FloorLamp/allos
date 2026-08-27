import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { LOGGED_VIA_FIELD, type WebLoggedVia } from "@/lib/logged-via";

// WHICH SURFACE OPENED THE ACTIVITY EDITOR (#3087), driven through the REAL components.
//
// WHY THE REAL ONES. The first version of this mechanism passed a synthetic opener
// placed inside a region and failed on the actual tree, because the defect was not in
// the mechanism at all — it was that no real consumer is mounted inside a region. Both
// openers that own one declare it in their own returned JSX, BELOW the `useActivityEditor()`
// call, and a component is not inside the provider it renders. So every open read
// `page`, and `startWorkout` posted `page` from the quick-log sheet exactly as it did
// from the Training page. A fixture opener cannot see that; only the real tree can, so
// the assertions below render `QuickLogSheet` inside `ActivityEditorProvider` and read
// the FormData the real `startWorkout` was called with.

const posted: FormData[] = [];
/** Every region the mounted editor has declared, in order. */
const editorRegion: WebLoggedVia[] = [];
/** The same, as seen by the workout dock — which sits in that region while CLOSED. */
const dockRegion: WebLoggedVia[] = [];

vi.mock("@/app/(app)/training/activity-actions", () => ({
  startWorkout: vi.fn(async (fd: FormData) => {
    posted.push(fd);
    return { ok: true as const, id: 7 };
  }),
  discardWorkout: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/training",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/(app)/log-sheet-actions", () => ({
  loadLogSheetContext: vi.fn(async () => null),
}));

// The workspace itself is not what is under test and drags the whole strength editor
// in with it. What it IS, for this question, is the thing mounted INSIDE the editor's
// region — so the stand-in reads that region the same way ActivityForm's
// `useLoggedViaStamp()` does, and every assertion below about "the editor's region" is
// read off a component actually mounted in it rather than off provider state.
function OverlayStandIn({ onClose }: { onClose: () => void }) {
  editorRegion.push(useLoggedVia());
  return (
    <button data-testid="activity-overlay" onClick={onClose}>
      close
    </button>
  );
}
vi.mock("../ActivityOverlay", () => ({ default: OverlayStandIn }));
// The dock is the OTHER thing inside the editor's region, and the only one still
// mounted while the editor is closed — which is exactly the window in which a stale
// declaration used to survive.
function DockStandIn() {
  dockRegion.push(useLoggedVia());
  return <div data-testid="workout-dock" />;
}
vi.mock("../WorkoutDock", () => ({ default: DockStandIn }));
vi.mock("../QuickEntryProvider", () => ({
  useQuickEntry: () => ({ open: vi.fn() }),
}));

import ActivityEditorProvider, {
  useActivityEditor,
} from "../ActivityEditorProvider";
import QuickLogSheet from "../QuickLogSheet";
import { useLoggedVia } from "../LoggedViaSurface";
import { TimezoneProvider } from "../TimezoneProvider";

/** The provider's required props, none of which this question turns on. */
const PROVIDER_PROPS = {
  units: { weight: "kg", distance: "km", energy: "kcal" },
  suggestions: { titles: [], exercises: [] },
  history: {},
  equipment: [],
  bodyweightKg: 70,
  trainingRelevant: true,
  strengthTrainingAvailable: true,
  deloadContext: { deloadWeek: false, lifts: [] },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function renderShell(children: React.ReactNode) {
  return render(
    <TimezoneProvider tz="UTC">
      <ActivityEditorProvider {...PROVIDER_PROPS}>
        {children}
      </ActivityEditorProvider>
    </TimezoneProvider>
  );
}

beforeEach(() => {
  posted.length = 0;
  editorRegion.length = 0;
  dockRegion.length = 0;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
});

const surfaceOf = (fd: FormData) => fd.get(LOGGED_VIA_FIELD);
/** The region the editor is declaring right now. */
const region = () => editorRegion.at(-1);

describe("the real quick-log sheet, inside the real provider", () => {
  it("starts a workout that records `quick-log`, not `page`", async () => {
    renderShell(<QuickLogSheet open onClose={() => {}} />);
    const bolt = await screen.findByTestId("quick-log-live-workout");
    await act(async () => {
      bolt.click();
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    // THE ACCEPTANCE. Measured `page` on this exact tree before the fix.
    expect(surfaceOf(posted[0])).toBe("quick-log");
  });

  it("declares `quick-log` as the OPEN EDITOR's region, so the form stamps it too", async () => {
    // `startWorkout` is one post at one instant; the editor then stays open and every
    // save the form makes stamps the region around it. Both have to be the sheet.
    renderShell(<QuickLogSheet open onClose={() => {}} />);
    await act(async () => {
      (await screen.findByTestId("quick-log-live-workout")).click();
    });
    await screen.findByTestId("activity-overlay");
    expect(region()).toBe("quick-log");
  });
});

describe("a domain page's own opener, which has no region and must not invent one", () => {
  function PageOpener() {
    const { openCreate, openLive } = useActivityEditor();
    return (
      <>
        <button data-testid="page-create" onClick={() => openCreate()}>
          Log activity
        </button>
        <button data-testid="page-live" onClick={() => openLive()}>
          Start workout
        </button>
      </>
    );
  }

  it("records `page`, which is the true answer for a page's own form", async () => {
    renderShell(<PageOpener />);
    await act(async () => {
      screen.getByTestId("page-create").click();
    });
    await screen.findByTestId("activity-overlay");
    expect(region()).toBe("page");
  });

  it("hands `page` to the workout it starts", async () => {
    renderShell(<PageOpener />);
    await act(async () => {
      screen.getByTestId("page-live").click();
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(surfaceOf(posted[0])).toBe("page");
  });

  describe("and the three things a declaration must not do", () => {
    function Both() {
      return (
        <>
          <PageOpener />
          <QuickLogSheet open onClose={() => {}} />
        </>
      );
    }

    it("does not let a REFUSED open re-attribute the editor that stayed open", async () => {
      // A live session started from the Training page is running. Tapping the sheet's
      // bolt is refused by `preserveCurrentWorkout` — it resumes, it does not restart.
      // The declaration used to be written before that refusal, so the running
      // workout's region silently became the sheet nobody had logged anything from.
      renderShell(<Both />);
      await act(async () => {
        screen.getByTestId("page-live").click();
      });
      await screen.findByTestId("activity-overlay");
      expect(region()).toBe("page");
      const before = posted.length;
      await act(async () => {
        screen.getByTestId("quick-log-live-workout").click();
      });
      // Refused: no second create, and the region is still the session's own.
      expect(posted).toHaveLength(before);
      expect(region()).toBe("page");
    });

    it("does not keep the last opener's surface after the editor CLOSES", async () => {
      // A closed editor has no opener. Without the release the last declaration
      // outlived it, and the next thing to appear in that region — a dock resume, or
      // #2471's post-deploy continuation — inherited a sheet nobody had tapped.
      //
      // Read off the DOCK, which is mounted inside the same region and, unlike the
      // workspace, is still there once the editor is closed.
      const { rerender } = render(
        <TimezoneProvider tz="UTC">
          <ActivityEditorProvider {...PROVIDER_PROPS}>
            <Both />
          </ActivityEditorProvider>
        </TimezoneProvider>
      );
      await act(async () => {
        (await screen.findByTestId("quick-log-log-activity")).click();
      });
      await screen.findByTestId("activity-overlay");
      expect(region()).toBe("quick-log");
      await act(async () => {
        screen.getByTestId("activity-overlay").click();
      });
      // A session the server says is running now appears — the fresh-load dock, the
      // shape a resume takes after the editor closed.
      rerender(
        <TimezoneProvider tz="UTC">
          <ActivityEditorProvider
            {...PROVIDER_PROPS}
            presence={{
              state: "active",
              activityId: 9,
              title: "Push",
              stale: false,
            }}
            liveEditData={{ id: 9, title: "Push", type: "strength" }}
          >
            <Both />
          </ActivityEditorProvider>
        </TimezoneProvider>
      );
      await screen.findByTestId("workout-dock");
      expect(dockRegion.at(-1)).toBe("page");
    });

    it("DOES take the new surface when a second open genuinely happens", async () => {
      // The counterpart, so the guard above cannot be satisfied by never updating: a
      // committed open from another region is a new editor session and must say so.
      renderShell(<Both />);
      await act(async () => {
        screen.getByTestId("page-create").click();
      });
      await screen.findByTestId("activity-overlay");
      expect(region()).toBe("page");
      await act(async () => {
        screen.getByTestId("quick-log-live-workout").click();
      });
      await waitFor(() => expect(region()).toBe("quick-log"));
    });
  });
});
