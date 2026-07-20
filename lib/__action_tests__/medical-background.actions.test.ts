// SERVER-ACTION TIER — the Medical → Background write path (#928). Smoking history
// (#83), health risk factors (#517), and the emergency card (#42) moved off Settings
// → Profile to the Medical surface, but the move is surface-only: the actions stay
// PROFILE-scoped and still gate on requireWriteAccess(). This spot-asserts the tier
// gate is intact after the move (acceptance §Action tier) and the writes land in
// profile_settings.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  saveSmokingHistory,
  saveRiskFactors,
  saveEmergencyCardSettings,
} from "@/app/(app)/medical/background/actions";
import {
  getSmokingHistory,
  getRiskAttributes,
  getEmergencyCardEnabled,
  getBloodType,
  getEmergencyContact,
} from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

describe("saveSmokingHistory", () => {
  it("persists the structured record to the acting profile", async () => {
    const login = createLogin();
    const profile = createProfile("smoker", login.id);
    actAs(login, profile);
    await saveSmokingHistory(
      fd({ smoking_status: "former", pack_years: "22", quit_year: "2016" })
    );
    expect(getSmokingHistory(profile.id)).toMatchObject({
      status: "former",
      packYears: 22,
      quitYear: 2016,
    });
    expect(revalidate).toHaveBeenCalledWith("/records");
  });

  it("refuses a read-only member (requireWriteAccess gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("smoker-ro", login.id);
    actAs(login, profile, "read");
    await expect(
      saveSmokingHistory(fd({ smoking_status: "current" }))
    ).rejects.toThrow(/read-only/);
    expect(getSmokingHistory(profile.id).status).toBeNull();
  });
});

describe("saveRiskFactors", () => {
  it("persists the boolean flags to the acting profile", async () => {
    const login = createLogin();
    const profile = createProfile("risk", login.id);
    actAs(login, profile);
    await saveRiskFactors(
      fd({
        healthcare_worker: "1",
        immunocompromised: "0",
        dialysis: "0",
        pregnant: "0",
        noise_exposure: "1",
      })
    );
    const attrs = getRiskAttributes(profile.id);
    expect(attrs.healthcareWorker).toBe(true);
    // Noise exposure (#717) persists through the same action → the hearing-screening
    // cadence input.
    expect(attrs.noiseExposure).toBe(true);
    expect(attrs.dialysis).toBe(false);
  });

  it("refuses a read-only member (requireWriteAccess gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("risk-ro", login.id);
    actAs(login, profile, "read");
    await expect(
      saveRiskFactors(fd({ healthcare_worker: "1" }))
    ).rejects.toThrow(/read-only/);
  });
});

describe("saveEmergencyCardSettings", () => {
  it("persists opt-in / blood type / contact to the acting profile", async () => {
    const login = createLogin();
    const profile = createProfile("emergency", login.id);
    actAs(login, profile);
    await saveEmergencyCardSettings(
      fd({
        emergency_enabled: "1",
        blood_type: "O+",
        emergency_contact_name: "Test Contact",
        emergency_contact_phone: "555-0123",
        emergency_contact_relation: "Spouse",
      })
    );
    expect(getEmergencyCardEnabled(profile.id)).toBe(true);
    expect(getBloodType(profile.id)).toBe("O+");
    expect(getEmergencyContact(profile.id)).toMatchObject({
      name: "Test Contact",
      relation: "Spouse",
    });
    // The card lives on the Passport page since the #1042 phase-3 merge.
    expect(revalidate).toHaveBeenCalledWith("/profile");
  });

  it("refuses a read-only member (requireWriteAccess gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("emergency-ro", login.id);
    actAs(login, profile, "read");
    await expect(
      saveEmergencyCardSettings(fd({ emergency_enabled: "1" }))
    ).rejects.toThrow(/read-only/);
    expect(getEmergencyCardEnabled(profile.id)).toBe(false);
  });
});
