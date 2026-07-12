// DB INTEGRATION TIER — per-profile home location round-trip + CCD adopt (issue #570).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getHomeLocation, setHomeLocation } from "@/lib/settings";
import { adoptProfileFromExtraction } from "@/lib/settings/profile-attrs";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("home location settings round-trip", () => {
  it("stores coarse coordinates and reads them back; clears with null", () => {
    const p = newProfile("home-rt");
    expect(getHomeLocation(p)).toBeNull();

    // A street-precise value is coarsened to ~11 km on write.
    setHomeLocation(p, { lat: 40.7128, lng: -74.006 });
    expect(getHomeLocation(p)).toEqual({ lat: 40.7, lng: -74 });
    // Stored as plain profile_settings rows (no migration).
    const rows = db
      .prepare(
        "SELECT key, value FROM profile_settings WHERE profile_id = ? AND key IN ('home_lat','home_lng') ORDER BY key"
      )
      .all(p);
    expect(rows).toEqual([
      { key: "home_lat", value: "40.7" },
      { key: "home_lng", value: "-74" },
    ]);

    setHomeLocation(p, null);
    expect(getHomeLocation(p)).toBeNull();
  });

  it("rejects an out-of-range coordinate", () => {
    const p = newProfile("home-bad");
    expect(() => setHomeLocation(p, { lat: 200, lng: 0 })).toThrow();
  });
});

describe("adoptProfileFromExtraction — home from patient ZIP (#570)", () => {
  const meta = {
    patient_sex: null,
    patient_birthdate: null,
    patient_age: null,
    patient_name: null,
    patient_postal_code: "10001",
  };

  it("suggests a coarse home location from a US ZIP when none is set", () => {
    const p = newProfile("adopt-home");
    const res = adoptProfileFromExtraction(p, meta);
    expect(res.homeAdopted).toBe(true);
    const home = getHomeLocation(p);
    expect(home).not.toBeNull();
    expect(home!.lat).toBeCloseTo(40.8, 1);
  });

  it("never overwrites an existing home location", () => {
    const p = newProfile("adopt-home-set");
    setHomeLocation(p, { lat: 12.3, lng: 45.6 });
    const res = adoptProfileFromExtraction(p, meta);
    expect(res.homeAdopted).toBe(false);
    expect(getHomeLocation(p)).toEqual({ lat: 12.3, lng: 45.6 });
  });

  it("skips a non-US / unknown ZIP", () => {
    const p = newProfile("adopt-home-foreign");
    const res = adoptProfileFromExtraction(p, {
      ...meta,
      patient_postal_code: "00000",
    });
    expect(res.homeAdopted).toBe(false);
    expect(getHomeLocation(p)).toBeNull();
  });
});
