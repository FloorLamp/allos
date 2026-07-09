"use client";

import { toggleStarBiomarker } from "@/app/(app)/biomarkers/actions";

// Star toggle for a biomarker's detail header. Submits the toggle server action
// (which inserts/deletes a starred_biomarkers row and revalidates the surfaces
// that show the pinned card).
export default function StarButton({
  canonicalName,
  starred,
}: {
  canonicalName: string;
  starred: boolean;
}) {
  return (
    <form action={toggleStarBiomarker}>
      <input type="hidden" name="canonical_name" value={canonicalName} />
      <button
        type="submit"
        aria-pressed={starred}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
          starred
            ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
            : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
        }`}
        title={starred ? "Unstar this biomarker" : "Star this biomarker"}
      >
        <span>{starred ? "★" : "☆"}</span>
        {starred ? "Starred" : "Star"}
      </button>
    </form>
  );
}
