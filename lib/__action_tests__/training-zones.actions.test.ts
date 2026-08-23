// SERVER-ACTION TIER — Training zone settings feed Training → Analyze (#3512),
// so their write must invalidate that owning surface as well as the settings page.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { saveTrainingZones } from "@/app/(app)/settings/profile/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
});

describe("saveTrainingZones", () => {
  it("revalidates the Training Analyze owner after saving", async () => {
    const login = createLogin();
    const profile = createProfile("training-zone-revalidation", login.id);
    actAs(login, profile);

    await saveTrainingZones(
      fd({ max_hr_override: 190, zone2_weekly_target_min: 120 })
    );

    expect(revalidate).toHaveBeenCalledWith("/settings/training");
    expect(revalidate).toHaveBeenCalledWith("/training");
  });
});
