// SERVER-ACTION TIER — the provider registry mutations (issue #275).
//
// Drives updateProviderAction + mergeProviderAction through the mocked auth guard.
// Both are global (admin) operations; this tier's mock makes requireAdmin() pass,
// so it asserts the WRITE behavior (identity edit, dedup-collision refusal,
// transactional re-point + delete, count-only impact through the DB), not the
// redirect a member would hit in prod (that's the real requireAdmin's job).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  updateProviderAction,
  mergeProviderAction,
} from "@/app/(app)/providers/actions";
import { getProvider } from "@/lib/queries";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function newProvider(name: string, dedup: string, npi: string | null = null) {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, npi, dedup_key) VALUES (?, 'individual', ?, ?)`
      )
      .run(name, npi, dedup).lastInsertRowid
  );
}

// Run an action that may redirect() on success (which throws NEXT_REDIRECT in this
// tier). Returns the resolved value, or null when it redirected.
async function runMaybeRedirect<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")
    )
      return null;
    throw err;
  }
}

beforeEach(() => {
  revalidate.mockClear();
  seedActor({ role: "admin", profileName: "Owner" });
});

describe("updateProviderAction", () => {
  it("rewrites the identity fields and revalidates", async () => {
    const id = newProvider("Dr. Old", `old-${Math.random()}`);
    const res = await updateProviderAction(
      fd({
        id,
        name: "Dr. New",
        type: "individual",
        npi: "1234567895",
        phone: "(555) 010-0142",
      })
    );
    expect(res.error).toBeUndefined();
    const p = getProvider(id)!;
    expect(p.name).toBe("Dr. New");
    expect(p.npi).toBe("1234567895");
    expect(p.phone).toBe("(555) 010-0142");
    expect(revalidate).toHaveBeenCalledWith(`/providers/${id}`);
  });

  it("refuses a blank name", async () => {
    const id = newProvider("Dr. Old", `old2-${Math.random()}`);
    const res = await updateProviderAction(fd({ id, name: "   " }));
    expect(res.error).toBeTruthy();
  });

  it("refuses an identity that collides with another provider", async () => {
    // A's dedup_key must be the NPI-based key the update recomputes, so B's edit
    // to the same NPI collides on it.
    const a = newProvider("Quest", "npi:1234567893", "1234567893");
    const b = newProvider("Labcorp", `lab-${Math.random()}`);
    const res = await updateProviderAction(
      fd({ id: b, name: "Labcorp", type: "individual", npi: "1234567893" })
    );
    expect(res.error).toMatch(/merge/i);
    // A collides, so B is unchanged.
    expect(getProvider(b)!.npi).toBeNull();
    expect(getProvider(a)!.npi).toBe("1234567893");
  });
});

describe("mergeProviderAction", () => {
  it("re-points links onto the survivor and deletes the duplicate", async () => {
    const owner = createProfile("MergeOwner");
    const survivor = newProvider("Dr. Keep", `keep-${Math.random()}`);
    const duplicate = newProvider("Dr. Drop", `drop-${Math.random()}`);
    db.prepare(
      `INSERT INTO encounters (profile_id, date, provider_id) VALUES (?, '2024-01-01', ?)`
    ).run(owner.id, duplicate);
    db.prepare(
      `INSERT INTO procedures (profile_id, name, provider_id) VALUES (?, 'X', ?)`
    ).run(owner.id, duplicate);

    const res = await runMaybeRedirect(
      mergeProviderAction(fd({ survivorId: survivor, duplicateId: duplicate }))
    );
    // Success path redirects → null.
    expect(res).toBeNull();
    expect(getProvider(duplicate)).toBeUndefined();
    expect(getProvider(survivor)).toBeDefined();
    const moved = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM encounters WHERE provider_id = ?) AS e,
           (SELECT COUNT(*) FROM procedures WHERE provider_id = ?) AS p`
      )
      .get(survivor, survivor) as { e: number; p: number };
    expect(moved.e).toBe(1);
    expect(moved.p).toBe(1);
  });

  it("errors on a self-merge without touching data", async () => {
    const p = newProvider("Solo", `solo-${Math.random()}`);
    const res = await mergeProviderAction(
      fd({ survivorId: p, duplicateId: p })
    );
    expect(res?.error).toBeTruthy();
    expect(getProvider(p)).toBeDefined();
  });

  it("errors when the duplicate is missing", async () => {
    const p = newProvider("Keep2", `keep2-${Math.random()}`);
    const res = await mergeProviderAction(
      fd({ survivorId: p, duplicateId: 999999 })
    );
    expect(res?.error).toBeTruthy();
  });
});
