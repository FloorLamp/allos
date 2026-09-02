"use client";

import { saveOwnProfile } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import type { SessionProfile } from "@/lib/auth";

// The own-profile association (issue #1013) — a LOGIN-scoped setting: which of the
// login's accessible profiles is "mine". Optional (a caregiver-only login leaves it
// unset). Purely an association — it grants no access; it only labels the login's
// self so a write to anyone else is named at the point of action. Constrained to the
// login's accessible profiles (the <select> lists exactly them); the server re-checks.
export default function OwnProfileForm({
  profiles,
  ownProfileId,
}: {
  // The login's accessible profiles, already disambiguated (#534) upstream.
  profiles: SessionProfile[];
  ownProfileId: number | null;
}) {
  const {
    status,
    value,
    save: runSave,
  } = useSaveStatus(ownProfileId != null ? String(ownProfileId) : "none");

  function save(next: string) {
    const fd = new FormData();
    fd.set("own_profile_id", next);
    runSave(next, async () => {
      const res = await saveOwnProfile(fd);
      if (!res.ok) throw new Error(res.error ?? "Couldn't save.");
    });
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Which profile is yours?
        </h2>
        <SaveStatus {...status} />
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Mark one profile as your own. When you log something for anyone else,
        the button names them — so a dose or weigh-in never lands on the wrong
        record. Leave it unset if none of these profiles is you.
      </p>
      <select
        data-testid="own-profile-select"
        value={value}
        onChange={(e) => save(e.target.value)}
        className="input"
      >
        <option value="none">None — not one of these</option>
        {profiles.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
