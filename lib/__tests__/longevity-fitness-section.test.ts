import { beforeEach, describe, expect, it, vi } from "vitest";
import FitnessSection from "@/app/(app)/longevity/FitnessSection";
import { requireSession } from "@/lib/auth";
import { getProfileAge } from "@/lib/settings";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getProfileAge: vi.fn() }));
vi.mock("@/lib/fitness-check-assemble", () => ({
  assembleFitnessCheckModel: vi.fn(),
}));

const section = {
  anchor: "fitness" as const,
  title: "Fitness",
  pillars: [],
};

describe("Longevity FitnessSection life-stage gate (#3065)", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockResolvedValue({
      profile: { id: 7 },
    } as Awaited<ReturnType<typeof requireSession>>);
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
});
