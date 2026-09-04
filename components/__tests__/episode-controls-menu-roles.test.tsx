import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import EpisodeControls from "@/components/illness/EpisodeControls";

vi.mock("@/app/(app)/medical/episodes/actions", () => ({
  createEpisodeShareLinkAction: vi.fn(),
  promoteEpisodeToConditionAction: vi.fn(),
  unpromoteEpisodeConditionAction: vi.fn(),
}));

// THE KEBAB'S ITEMS ARE ITEMS OF THE KEBAB (#5181).
//
// The panel has declared `role="menu"` since #3374 — in both presentations — but
// two of its three items were plain buttons. A `role="menu"` whose children are
// not menu items is not a menu to a screen reader: it states an item count that
// counts one of the three, and the other two are announced as loose buttons
// inside it. `lib/__tests__/menu-item-role-scan.test.ts` holds the whole app to
// this; here it is asserted where a browser can see it, at the site that drifted.
//
// BY ROLE, NOT BY TAG. The elements were always <button>s and always rendered;
// what was wrong was what they announced. An assertion on the tag or the testid
// passes either way — which is exactly how this survived the lane that found it.
function mount(promoted: boolean) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <EpisodeControls
          episodeId={7}
          situation="Flu"
          ongoing={!promoted}
          promoted={promoted}
          canWrite
          editor={{
            startDate: "2026-01-02",
            endDate: null,
            note: null,
            outcome: null,
          }}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function openMenu() {
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
  const panel = document.body.querySelector<HTMLElement>(
    '[data-anchored-panel="popover"]'
  );
  expect(panel).not.toBeNull();
  return panel!;
}

describe("the episode kebab's items (#5181)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  it.each([
    [false, ["Edit episode", "Promote to condition"]],
    [true, ["Edit episode", "Remove condition"]],
  ])("promoted=%s: every item answers to menuitem", (promoted, names) => {
    mount(promoted as boolean);
    const panel = openMenu();
    expect(panel.getAttribute("role")).toBe("menu");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      names
    );
  });

  it("leaves no command in the panel outside the menu", () => {
    mount(false);
    const panel = openMenu();
    // The converse of the list above, and the half that catches an item ADDED
    // later without the role: nothing clickable in here is a non-item.
    const strays = Array.from(panel.querySelectorAll("button, a")).filter(
      (el) => !/^menuitem/.test(el.getAttribute("role") ?? "")
    );
    expect(strays.map((el) => el.textContent)).toEqual([]);
  });
});
