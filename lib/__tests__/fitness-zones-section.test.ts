import { beforeEach, describe, expect, it, vi } from "vitest";
import FitnessZonesSection from "@/app/(app)/training/FitnessZonesSection";
import { requireSession } from "@/lib/auth";
import {
  getCardioIntensityMix,
  getCardioVolumeByWeek,
  getTrainingZoneData,
} from "@/lib/queries";

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db", () => ({ today: vi.fn(() => "2026-08-23") }));
vi.mock("@/lib/queries", () => ({
  getCardioIntensityMix: vi.fn(),
  getCardioVolumeByWeek: vi.fn(),
  getTrainingZoneData: vi.fn(),
}));
vi.mock("@/app/(app)/training/TrainingZonesSection", () => ({
  default: () => null,
}));

beforeEach(() => {
  vi.mocked(requireSession).mockResolvedValue({
    profile: { id: 7 },
  } as Awaited<ReturnType<typeof requireSession>>);
  vi.mocked(getCardioIntensityMix).mockClear();
  vi.mocked(getCardioVolumeByWeek).mockClear();
  vi.mocked(getTrainingZoneData).mockReset();
});

describe("Training Analyze zone-data gate (#3512)", () => {
  it("does not gather discarded cardio aggregates when zone content is absent", async () => {
    vi.mocked(getTrainingZoneData).mockReturnValue({
      model: null,
      split: { totalMin: 0 },
    } as ReturnType<typeof getTrainingZoneData>);

    await expect(
      FitnessZonesSection({
        window: {
          from: "2026-05-31",
          to: "2026-08-23",
          days: 84,
          allTime: false,
        },
        weeks: 12,
      })
    ).resolves.toBeNull();

    expect(getTrainingZoneData).toHaveBeenCalledWith(7, 12, "2026-08-23");
    expect(getCardioVolumeByWeek).not.toHaveBeenCalled();
    expect(getCardioIntensityMix).not.toHaveBeenCalled();
  });
});
