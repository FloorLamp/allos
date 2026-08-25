import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { shiftDateStr } from "@/lib/date";
import type { DigestSeries } from "@/lib/trends-digest";
import type { CadenceWindow } from "@/lib/queries/cadence-ledger";
import type { TrendsDigestGatherRow } from "@/lib/queries/trends-digest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  buildDigestSeries: vi.fn(),
  buildPracticeDigestSeries: vi.fn(),
  cadenceWindows: vi.fn(),
  getTrendsDigestGather: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ today: () => "2026-02-26" }));
vi.mock("@/lib/trends-series", () => ({
  buildDigestSeries: mocks.buildDigestSeries,
  buildPracticeDigestSeries: mocks.buildPracticeDigestSeries,
}));
vi.mock("@/lib/queries", () => ({
  getFindingSuppressions: () => new Map(),
  getMacroFiberDays: () => [],
}));
vi.mock("@/lib/queries/cadence-ledger", () => ({
  cadenceWindows: mocks.cadenceWindows,
}));
vi.mock("@/lib/queries/trends-digest", () => ({
  getTrendsDigestGather: mocks.getTrendsDigestGather,
}));
vi.mock("@/app/(app)/trends/actions", () => ({
  dismissDigest: vi.fn(),
}));

import TrendingDigest from "@/app/(app)/trends/TrendingDigest";

describe("TrendingDigest", () => {
  it("renders logging cadence as neutral factual copy with no destination", async () => {
    const windows: CadenceWindow[] = Array.from({ length: 8 }, (_, index) => {
      const start = shiftDateStr("2026-01-01", index * 7);
      return {
        start,
        end: shiftDateStr(start, 6),
        isCurrent: false,
        elapsedDays: 7,
      };
    });
    const foodDates = [6, 6, 6, 6, 3, 3, 3, 3].flatMap((count, week) =>
      Array.from({ length: count }, (_, day) =>
        shiftDateStr(windows[week].start, day)
      )
    );
    const linkedControl: DigestSeries = {
      key: "result:LDL",
      label: "LDL",
      range: { low: null, high: 100 },
      points: [
        { date: "2026-01-01", value: 99 },
        { date: "2026-02-25", value: 101 },
      ],
    };
    const rows: TrendsDigestGatherRow[] = foodDates.map((date) => ({
      kind: "food-serving",
      key: "vegetables",
      date,
      value: 1,
    }));

    mocks.requireSession.mockResolvedValue({
      login: { id: 1 },
      profile: { id: 2 },
    });
    mocks.buildDigestSeries.mockReturnValue([linkedControl]);
    mocks.buildPracticeDigestSeries.mockReturnValue([]);
    mocks.cadenceWindows.mockReturnValue(windows);
    mocks.getTrendsDigestGather.mockReturnValue(rows);

    render(
      await TrendingDigest({
        range: { from: windows[0].start, to: windows.at(-1)?.end },
      })
    );

    const cadenceChip = screen.getByText(
      "Food logging ↓ 50% — larger than its recent variation"
    );
    expect(cadenceChip.getAttribute("data-tone")).toBe("neutral");
    expect(cadenceChip.textContent).not.toMatch(
      /\b(should|must|need to|try to|better|worse|good|bad)\b/i
    );
    expect(cadenceChip.closest("a")).toBeNull();

    // Positive control: the same wrapper links a result chip, so the absence above
    // proves the logging-key decision rather than an inert Link branch.
    const resultLink = screen
      .getByText("LDL ↑ 2% — into high range")
      .closest("a");
    expect(resultLink?.getAttribute("href")).toBe(
      "/results/clinical-results/view?name=LDL"
    );
  });
});
