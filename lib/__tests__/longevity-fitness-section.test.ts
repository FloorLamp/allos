import { beforeEach, describe, expect, it, vi } from "vitest";
import BioAgeSection from "@/app/(app)/longevity/BioAgeSection";
import FitnessSection from "@/app/(app)/longevity/FitnessSection";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs, getProfileAge } from "@/lib/settings";
import { getBioAgeReadings } from "@/lib/queries";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/settings", () => ({
  getProfileAge: vi.fn(),
  getDisplayFormatPrefs: vi.fn(),
}));
vi.mock("@/lib/queries", () => ({ getBioAgeReadings: vi.fn() }));
vi.mock("@/lib/fitness-check-assemble", () => ({
  assembleFitnessCheckModel: vi.fn(),
}));

const section = {
  anchor: "fitness" as const,
  title: "Fitness",
  pillars: [],
};

describe("Longevity section life-stage gates (#3065)", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue({
      login: { id: 3 },
      profile: { id: 7 },
    } as Awaited<ReturnType<typeof requireSession>>);
    vi.mocked(getDisplayFormatPrefs).mockClear();
    vi.mocked(getBioAgeReadings).mockClear();
    vi.mocked(assembleFitnessCheckModel).mockClear();
  });

  it.each([
    ["minor", 15],
    ["unknown", null],
  ])("returns null for a %s profile", async (_label, age) => {
    vi.mocked(getProfileAge).mockReturnValue(age);
    expect(await FitnessSection({ section })).toBeNull();
    expect(assembleFitnessCheckModel).not.toHaveBeenCalled();
  });

  it.each([
    ["minor", 15],
    ["unknown", null],
  ])("returns no biological-age hero for a %s profile", async (_label, age) => {
    vi.mocked(getProfileAge).mockReturnValue(age);
    expect(await BioAgeSection()).toBeNull();
    expect(getDisplayFormatPrefs).not.toHaveBeenCalled();
    expect(getBioAgeReadings).not.toHaveBeenCalled();
  });
});
