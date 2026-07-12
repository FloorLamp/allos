"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isBiomarkerStarred, unstarBiomarkerFamily } from "@/lib/queries";

// Star / unstar a biomarker (toggles a starred_biomarkers row). Revalidates the
// surfaces that show the pinned card: /biomarkers and the dashboard.
export async function toggleStarBiomarker(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("canonical_name") ?? "").trim();
  if (!name) return;
  // Check-then-act as one atomic transaction so concurrent toggles can't both
  // read the same state and race (e.g. two inserts, or an insert lost to a delete).
  const toggle = db.transaction(() => {
    if (isBiomarkerStarred(profile.id, name)) {
      // Unstar the whole #482 family: a star on any member lights the family, so
      // clearing must remove every member's pin, not just this exact name (else the
      // toggle would read as still-starred).
      unstarBiomarkerFamily(profile.id, name);
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, ?)"
      ).run(profile.id, name);
    }
  });
  toggle();
  revalidatePath("/biomarkers");
  revalidatePath("/biomarkers/view", "page");
  revalidatePath("/");
}
