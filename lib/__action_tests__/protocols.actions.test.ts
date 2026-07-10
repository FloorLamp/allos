// SERVER-ACTION TIER — protocols write path (issue #161).
//
// Covers create (outcome-key set stored as JSON + situation activation), end
// (sets end_date + inverts the situation activation), delete (row + side-state),
// and profile scoping. redirect() is mocked to a no-op since it's the last
// statement of create/delete.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createProtocol,
  updateProtocol,
  endProtocol,
  deleteProtocol,
} from "@/app/(app)/protocols/actions";
import { getProtocols } from "@/lib/queries";
import { getActiveSituations } from "@/lib/settings";
import { seedActor, actAs, createProfile } from "./harness";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

// FormData builder allowing repeated outcome_keys.
function protocolForm(fields: {
  id?: number;
  name?: string;
  start_date?: string;
  end_date?: string;
  notes?: string;
  situation?: string;
  outcome_keys?: string[];
}): FormData {
  const form = new FormData();
  if (fields.id != null) form.set("id", String(fields.id));
  if (fields.name != null) form.set("name", fields.name);
  if (fields.start_date != null) form.set("start_date", fields.start_date);
  if (fields.end_date != null) form.set("end_date", fields.end_date);
  if (fields.notes != null) form.set("notes", fields.notes);
  if (fields.situation != null) form.set("situation", fields.situation);
  for (const k of fields.outcome_keys ?? []) form.append("outcome_keys", k);
  return form;
}

describe("createProtocol", () => {
  it("stores the protocol with a normalized outcome-key set and activates the situation", async () => {
    const { profile } = seedActor();
    await createProtocol(
      protocolForm({
        name: "Creatine 5 g/day",
        start_date: "2026-05-01",
        situation: "Creatine loading",
        outcome_keys: [
          "metric:weight",
          "metric:weight", // dupe dropped
          "biomarker:Creatine Kinase",
          "junk", // unparseable dropped
        ],
      })
    );

    const rows = getProtocols(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Creatine 5 g/day");
    expect(rows[0].end_date).toBeNull();
    expect(rows[0].outcomeKeys).toEqual([
      "metric:weight",
      "biomarker:Creatine Kinase",
    ]);
    // Situation activated via the shared situations wiring.
    expect(getActiveSituations(profile.id)).toContain("Creatine loading");
    expect(revalidate).toHaveBeenCalledWith("/protocols");
  });
});

describe("endProtocol", () => {
  it("sets the end date and deactivates the situation (no sibling holds it)", async () => {
    const { profile } = seedActor();
    await createProtocol(
      protocolForm({
        name: "Sauna block",
        start_date: "2026-05-01",
        situation: "Sauna block",
      })
    );
    const p = getProtocols(profile.id)[0];
    expect(getActiveSituations(profile.id)).toContain("Sauna block");

    await endProtocol(protocolForm({ id: p.id }));

    const after = getProtocols(profile.id)[0];
    expect(after.end_date).not.toBeNull();
    expect(getActiveSituations(profile.id)).not.toContain("Sauna block");
  });
});

describe("deleteProtocol", () => {
  it("removes the row and reverses its situation activation", async () => {
    const { profile } = seedActor();
    await createProtocol(
      protocolForm({
        name: "TRE 16:8",
        start_date: "2026-05-01",
        situation: "Fasting window",
      })
    );
    const p = getProtocols(profile.id)[0];
    await deleteProtocol(protocolForm({ id: p.id }));
    expect(getProtocols(profile.id)).toHaveLength(0);
    expect(getActiveSituations(profile.id)).not.toContain("Fasting window");
  });
});

describe("profile scoping", () => {
  it("a write never lands on another profile, and cross-profile end is a no-op", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("Other subject", login.id);

    actAs(login, profileA);
    await createProtocol(
      protocolForm({ name: "A protocol", start_date: "2026-05-01" })
    );
    const a = getProtocols(profileA.id)[0];
    expect(getProtocols(profileB.id)).toHaveLength(0);

    // Acting as B, ending A's id must not touch A.
    actAs(login, profileB);
    await endProtocol(protocolForm({ id: a.id }));
    actAs(login, profileA);
    expect(getProtocols(profileA.id)[0].end_date).toBeNull();
  });
});
