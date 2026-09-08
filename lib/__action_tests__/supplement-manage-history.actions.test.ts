// @vitest-environment jsdom
// Real async gather and rendered row: retirement must not erase item-owned context.
import {
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
} from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/components/__tests__/setup";
import { db, rawDb, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setActiveSituations, setTimezone } from "@/lib/settings";
import { invalidateDoseScheduleVersions } from "@/lib/queries/intake/schedule";
import { up as retireBlankDoses } from "@/lib/migrations/versions/20260908-retire-blank-intake-doses";
import ManageTab from "@/app/(app)/nutrition/ManageTab";
import EditableSupplementRow from "@/app/(app)/nutrition/EditableSupplementRow";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import { seedActor, createProfile, actAs } from "./harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/nutrition",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

type Row = ReactElement<ComponentProps<typeof EditableSupplementRow>>;
type Region = "active" | "held" | "paused";
function gatheredRows(tree: unknown, region?: Region): Row[] {
  const rows: Row[] = [];
  function visit(node: unknown, location: Region = "active") {
    if (Array.isArray(node))
      return node.forEach((child) => visit(child, location));
    if (!isValidElement<Record<string, unknown>>(node)) return;
    if (node.props["data-testid"] === "held-section") location = "held";
    const firstChild = Array.isArray(node.props.children)
      ? node.props.children[0]
      : undefined;
    if (
      isValidElement<{ children: unknown[] }>(firstChild) &&
      firstChild.type === "summary" &&
      firstChild.props.children[0] === "Paused ("
    )
      location = "paused";
    if (node.type === EditableSupplementRow) {
      if (!region || location === region) rows.push(node as Row);
    } else Object.values(node.props).forEach((child) => visit(child, location));
  }
  visit(tree);
  return rows;
}

function seedHistory(profileId: number, name: string) {
  setTimezone(profileId, "UTC");
  const now = today(profileId),
    past = shiftDateStr(now, -1),
    start = shiftDateStr(now, -2);
  const supplyId = Number(
    db
      .prepare("INSERT INTO shared_supplies(name) VALUES (?)")
      .run(`${name} bottle`).lastInsertRowid
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
    (profile_id, name, kind, obligation, supply_id, created_at)
    VALUES (?, ?, 'supplement', 'must', ?, ?)`
      )
      .run(profileId, name, supplyId, `${start} 00:00:00`).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
    (item_id, time_of_day, amount, created_at) VALUES (?, NULL, NULL, ?)`
      )
      .run(itemId, `${start} 00:00:00`).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_dose_schedule_versions
    (dose_id, effective_from, time_of_day, amount, amount_captured)
    VALUES (?, ?, 'Morning', '250 mg', 1), (?, ?, NULL, NULL, 1)`
  ).run(doseId, start, doseId, now);
  db.prepare(
    `INSERT INTO intake_item_logs
    (dose_id, item_id, date, status, amount, product, occurred_at)
    VALUES (?, ?, ?, 'taken', '250 mg', 'Recorded bottle', ?)`
  ).run(doseId, itemId, past, `${past}T08:00:00Z`);
  invalidateDoseScheduleVersions(profileId);
  return { itemId, doseId, supplyId, past };
}

describe("Manage keeps item context after the last dose retires", () => {
  it.each(["active", "held", "paused"] as const)(
    "%s row retains Restore, read-only history and shared supply",
    async (state) => {
      const { login, profile } = seedActor({ role: "member" });
      const own = seedHistory(profile.id, "Historical supplement");
      const foreign = createProfile("Other subject", login.id);
      const other = seedHistory(foreign.id, "Other supplement");
      retireBlankDoses(rawDb);
      if (state === "held") {
        setActiveSituations(profile.id, ["Travel"]);
        db.prepare(
          `UPDATE intake_items SET pause_situation_id =
        (SELECT id FROM situations WHERE profile_id = ? AND name = 'Travel') WHERE id = ?`
        ).run(profile.id, own.itemId);
      }
      if (state === "paused")
        db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(
          own.itemId
        );

      const tree = await ManageTab({});
      const rows = gatheredRows(tree);
      expect(
        gatheredRows(tree, state).map((row) => row.props.supplement.id)
      ).toEqual([own.itemId]);
      expect(rows.map((row) => row.props.supplement.id)).toEqual([own.itemId]);
      const row = rows[0];
      expect(row.props.doses).toEqual([]);
      expect(row.props.dose).toBeUndefined();
      expect(row.props.isTaken).toBeUndefined();
      expect(row.props.isSkipped).toBeUndefined();
      expect(row.props.retiredDoses?.map((d) => d.id)).toEqual([own.doseId]);
      expect(row.props.doseHistory).toMatchObject([
        {
          doseId: own.doseId,
          date: own.past,
          amount: "250 mg",
          product: "Recorded bottle",
        },
      ]);
      expect(row.props.strip.find((d) => d.date === own.past)?.state).toBe(
        "taken"
      );
      expect(row.props.poolChip?.supplyId).toBe(own.supplyId);
      expect(row.props.supplement.active).toBe(state === "paused" ? 0 : 1);
      if (state === "held")
        expect(row.props.supplement.pause_situation).toBe("Travel");

      render(
        createElement(
          ToastProvider,
          null,
          createElement(ConfirmProvider, null, row)
        )
      );
      expect(screen.getByTestId("shared-supply-chip").textContent).toContain(
        "Historical supplement bottle"
      );
      expect(
        screen.getByTestId("supplement-row-details").textContent
      ).toContain("Not scheduled");
      expect(screen.queryByTestId("dose-status")).toBeNull();
      expect(screen.getByTestId("adherence-summary").textContent).toContain(
        "50%"
      );
      fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
      if (state === "paused")
        expect(screen.getByRole("menuitem", { name: "Resume" })).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: "Dose history" }));
      const history = screen.getByTestId("dose-history");
      expect(
        within(history).getByTestId("dose-history-row").textContent
      ).toContain("250 mg");
      expect(history.textContent).toContain("Recorded bottle");
      expect(within(history).queryByTestId("dose-history-add")).toBeNull();
      expect(within(history).queryByTestId("overflow-menu-trigger")).toBeNull();
      expect(history.textContent).not.toContain("backfill");
      fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
      await act(async () =>
        fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }))
      );
      fireEvent.click(screen.getByTestId("intake-fact-dose"));
      expect(screen.getByTestId(`restore-dose-${own.doseId}`)).toBeTruthy();

      // Positive profile control: the foreign row exists and is reachable only under its own gather.
      actAs(login, foreign);
      expect(
        gatheredRows(await ManageTab({})).map((r) => r.props.supplement.id)
      ).toEqual([other.itemId]);
    }
  );

  it("keeps the same item context beside a live sibling whose status belongs to Day", async () => {
    const { profile } = seedActor();
    const own = seedHistory(profile.id, "Sibling supplement");
    retireBlankDoses(rawDb);
    const liveId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
      (item_id, time_of_day, amount) VALUES (?, 'Morning', '100 mg')`
        )
        .run(own.itemId).lastInsertRowid
    );
    const [row] = gatheredRows(await ManageTab({}));
    expect(row.props.dose?.id).toBe(liveId);
    expect(row.props.doses.map((d) => d.id)).toEqual([liveId]);
    expect(row.props.retiredDoses?.map((d) => d.id)).toEqual([own.doseId]);
    expect(row.props.doseHistory).toMatchObject([{ doseId: own.doseId }]);
    expect(row.props.poolChip?.supplyId).toBe(own.supplyId);
    expect(row.props.isTaken).toBeUndefined();
    expect(row.props.isSkipped).toBeUndefined();
    render(
      createElement(
        ToastProvider,
        null,
        createElement(ConfirmProvider, null, row)
      )
    );
    expect(screen.queryByTestId("dose-status")).toBeNull();
    fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Dose history" }));
    expect(screen.getByTestId("dose-history-add")).toBeTruthy();
  });
});
