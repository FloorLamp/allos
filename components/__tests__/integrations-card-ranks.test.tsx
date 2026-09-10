import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import PortalsSurface from "@/app/(app)/integrations/patient-portals/PortalsSurface";
import CalendarFeedConfig from "@/app/(app)/integrations/calendar-feed/CalendarFeedConfig";
import { loudIn } from "./loud-controls";

// THE INTEGRATIONS CARDS' TWO RANKS, ASSERTED AS A PAIR (#4978 slice 6, PM
// ruling 6 of 2026-09-09: on a multi-card route the surface is the CARD).
//
// /integrations/patient-portals is the route the ruling is about — one card per
// portal plus the add-portal card — so the claim it makes is per card, not per
// page: each card spends ONE filled control on its own commit and paints every
// neighbour beside it quiet.
//
// The two halves are checked TOGETHER because the state the owner declined
// (ruling (3), 2026-09-05) is exactly the half-converted one: a commit on the
// primitive's smaller box beside a Cancel still wearing the raw family's larger
// type. Read off the RENDERED classes rather than the call site, so a mount that
// silently lost `variant` reddens here too.

vi.mock("@/app/(app)/integrations/patient-portals/actions", () => ({
  addPortalAction: vi.fn(),
  renamePortalAction: vi.fn(),
  editPortalSoftwareAction: vi.fn(),
  removePortalAction: vi.fn(),
  addAccountAction: vi.fn(),
  renameAccountAction: vi.fn(),
  removeAccountAction: vi.fn(),
  bindIdentityAction: vi.fn(),
  unbindIdentityAction: vi.fn(),
  remapIdentityAction: vi.fn(),
  bindPendingIdentityAction: vi.fn(),
  ignorePendingIdentityAction: vi.fn(),
  dismissPendingIdentityAction: vi.fn(),
  requestSyncAction: vi.fn(),
}));
vi.mock("@/app/(app)/integrations/calendar-feed/actions", () => ({
  enableCalendarFeedAction: vi.fn(),
  disableCalendarFeedAction: vi.fn(),
  setCalendarFeedDetailAction: vi.fn(),
  setCalendarFeedOptionsAction: vi.fn(),
}));

const RAW_FAMILY = /\b(btn|btn-ghost|btn-danger|btn-sm)\b/;

const profile = {
  id: 2,
  name: "Sam",
  photoPath: null,
  photoVersion: 0,
};

function mountPortals() {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <PortalsSurface
          stage="map-patients"
          checklist={null}
          lead="Portals"
          portals={[
            { id: 1, name: "Ochsner MyChart", software: null },
            { id: 2, name: "Community Health", software: null },
          ]}
          accounts={[
            {
              id: 11,
              portalId: 1,
              name: "Default login",
              implicit: true,
              hasReport: true,
              status: {
                tone: "ok",
                text: "Checked today",
                segments: [{ kind: "text", text: "Checked today" }],
              },
              history: [],
              openRequestLine: null,
            },
            {
              id: 12,
              portalId: 2,
              name: "Default login",
              implicit: true,
              hasReport: false,
              status: {
                tone: "attention",
                text: "Never run",
                segments: [{ kind: "text", text: "Never run" }],
              },
              history: [],
              openRequestLine: null,
            },
          ]}
          identities={[]}
          pending={[
            {
              id: 21,
              accountId: 11,
              patientLabel: "SAM R",
              firstSeenOnDay: "2026-09-01",
              lastSeenOnDay: "2026-09-02",
              seenCount: 1,
              suggestion: null,
            },
          ]}
          profiles={[profile]}
          writableProfiles={[profile]}
          isAdmin={true}
          canAct={true}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

// Every control the primitive owns, as RENDERED: on the one control box, off the
// retiring raw family, and carrying the rank the card gave it.
function expectRank(el: HTMLElement, filled: boolean) {
  expect(el.hasAttribute("data-button-control")).toBe(true);
  expect(el.className).toContain("button-control");
  expect(el.className).not.toMatch(RAW_FAMILY);
  expect(el.className.includes("button-control-primary")).toBe(filled);
}

afterEach(cleanup);

describe("a patient-portals card spends one filled control on its own commit", () => {
  it("fills the add-portal card's commit and quiets the Cancel beside it", () => {
    mountPortals();
    fireEvent.click(screen.getByTestId("portal-add-toggle"));

    const card = screen.getByTestId("portal-add-card");
    expectRank(within(card).getByTestId("portal-add"), true);
    expectRank(within(card).getByTestId("portal-add-cancel"), false);
    expect(loudIn(card)).toEqual(["Add portal"]);
  });

  it("keeps a row's single action loud and every doored commit quiet", () => {
    mountPortals();
    const mapping = document.querySelector<HTMLElement>(
      '[data-portal-name="Ochsner MyChart"]'
    )!;

    // A pending row's Map is the ROW's single action, so it is loud on its row:
    // the doctrine nests (form, card, row) and a row's rank is not the card's.
    expectRank(within(mapping).getByTestId("pending-map"), true);
    // The login header's ask is a maintenance verb, not a commit.
    expectRank(within(mapping).getByTestId("sync-request-ask"), false);

    const waiting = document.querySelector<HTMLElement>(
      '[data-portal-name="Community Health"]'
    )!;
    expectRank(within(waiting).getByTestId("portal-add-login-cta"), false);
    expect(loudIn(waiting)).toEqual([]);

    // CARVE-OUT 1 OF RULING 6, ASSERTED BY THE STATE THAT PROVES IT RATHER THAN
    // BY ONE FOLD AT A TIME. Every commit on a portal card sits behind a door
    // opened by its OWN boolean, so two of them stand open side by side the
    // moment a reader opens two doors — and two filled controls on one card is
    // exactly what the doctrine forbids. So the card carries no loud control at
    // all rather than one picked by declaration order. Opening both doors here
    // is what would redden if a later change filled either commit.
    fireEvent.click(within(waiting).getByTestId("portal-add-login-cta"));
    fireEvent.click(within(waiting).getByTestId("prebind-toggle"));
    const accountAdd = within(waiting).getByTestId("account-add");
    const bindAdd = within(waiting).getByTestId("bind-add");
    expectRank(accountAdd, false);
    expectRank(within(waiting).getByTestId("account-add-cancel"), false);
    expectRank(bindAdd, false);
    expectRank(within(waiting).getByTestId("prebind-cancel"), false);
    expect(loudIn(waiting)).toEqual([]);
  });
});

function renderCalendarFeed() {
  render(
    <CalendarFeedConfig
      enabled={true}
      detail="minimal"
      categories={[]}
      reminders={false}
      pastWindowDays={30}
      futureWindowDays={null}
      baseUrl="https://allos.test"
      status="active"
      createdAt="2026-09-01T10:00:00Z"
      lastUsedAt={null}
      expiresOnDay={null}
    />
  );
  const save = screen.getByTestId("calendar-feed-options-save");
  const card = save.closest(".card");
  if (!(card instanceof HTMLElement)) throw new Error("save is not on a card");
  return { save, card };
}

describe("a calendar-feed card spends its one rank on its own commit", () => {
  it("fills the feed-options Save and renders the disconnect loud beside it", () => {
    const { save, card } = renderCalendarFeed();
    expectRank(save, true);

    // TWO FILLS ON ONE CARD, AND THE POINT IS THAT THE COUNT NOW SAYS SO. The
    // Disable beside the Save is a `DestructiveSubmit`; until #5696 the fill came
    // from `.destructive-submit` repainting a rank-LESS child, so this spec could
    // — and did — assert "exactly one filled control" while the card rendered
    // two. The wrapper states `variant="danger"` now, so the second fill is in
    // the census, and this pins what the card actually renders today.
    expect(loudIn(card)).toEqual(["Save feed options", "Disable feed"]);
  });

  // OWNER RULING 12 (#4978, 2026-09-10): on this card the Save keeps the fill,
  // the Disable goes quiet, and the red moves to its confirm step — a standalone
  // destructive control stays filled only on a surface with no commit of its
  // own. That conversion reaches `IntegrationDisconnectButton` across the seven
  // integration pages that pair a disconnect with a commit and is sequenced as
  // its own lane after #5726, so it is not made here. This is the assertion that
  // lane makes true; it is skipped rather than deleted so the card's budget has
  // a stated target instead of only a pinned overspend.
  it.skip("spends its one loud control on the Save (ruling 12)", () => {
    const { card } = renderCalendarFeed();
    expect(loudIn(card)).toEqual(["Save feed options"]);
  });
});
