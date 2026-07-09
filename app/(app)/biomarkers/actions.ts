"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isBiomarkerStarred } from "@/lib/queries";

// Star / unstar a biomarker (toggles a starred_biomarkers row). Revalidates the
// surfaces that show the pinned card: /biomarkers and the dashboard.
export async function toggleStarBiomarker(formData: FormData) {
  const { profile } = requireWriteAccess();
  const name = String(formData.get("canonical_name") ?? "").trim();
  if (!name) return;
  // Check-then-act as one atomic transaction so concurrent toggles can't both
  // read the same state and race (e.g. two inserts, or an insert lost to a delete).
  const toggle = db.transaction(() => {
    if (isBiomarkerStarred(profile.id, name)) {
      db.prepare(
        "DELETE FROM starred_biomarkers WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE"
      ).run(profile.id, name);
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
