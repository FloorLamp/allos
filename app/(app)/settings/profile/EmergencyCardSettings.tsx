"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { BLOOD_TYPES } from "@/lib/emergency-card";
import type { EmergencyContactSetting } from "@/lib/settings";
import { saveEmergencyCardSettings } from "./actions";

// Settings → Profile card for the offline Emergency Card (issue #42): the opt-in
// toggle (OFF by default), a manual blood type, and the emergency contact. All are
// per-profile. When the toggle is turned off here we also clear the offline copy
// from this device immediately, so disabling the feature doesn't leave a cached
// card behind until the next /emergency visit.
export default function EmergencyCardSettings({
  enabled: initialEnabled,
  bloodType: initialBloodType,
  contact: initialContact,
}: {
  enabled: boolean;
  bloodType: string | null;
  contact: EmergencyContactSetting;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [bloodType, setBloodType] = useState(initialBloodType ?? "");
  const [contact, setContact] =
    useState<EmergencyContactSetting>(initialContact);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: {
    enabled: boolean;
    bloodType: string;
    contact: EmergencyContactSetting;
  }) {
    const fd = new FormData();
    fd.set("emergency_enabled", next.enabled ? "1" : "0");
    fd.set("blood_type", next.bloodType);
    fd.set("emergency_contact_name", next.contact.name);
    fd.set("emergency_contact_phone", next.contact.phone);
    fd.set("emergency_contact_relation", next.contact.relation);
    // Turning the toggle off clears the offline copy on THIS device right away.
    if (!next.enabled) clearEmergencyPayload();
    runSave(async () => {
      await saveEmergencyCardSettings(fd);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Emergency card
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        A terse, printable summary of allergies, active medications, conditions,
        blood type, and who to call.{" "}
        <Link
          href="/emergency"
          className="text-brand-600 hover:underline dark:text-brand-400"
        >
          Open the card
        </Link>
        .
      </p>

      <label className="flex items-start gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          data-testid="emergency-toggle"
          checked={enabled}
          onChange={(e) => {
            const v = e.target.checked;
            setEnabled(v);
            save({ enabled: v, bloodType, contact });
          }}
          className="mt-0.5 h-4 w-4 accent-brand-600"
        />
        <span>
          Keep an offline copy on this device
          <span className="mt-0.5 block text-xs font-normal text-slate-400 dark:text-slate-500">
            Off by default. When on, the card is readable on this device with no
            network — and without logging in. That&rsquo;s the point in an
            emergency, but it also means anyone holding the unlocked phone can
            read it.
          </span>
        </span>
      </label>

      <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
        <label className="label">Blood type</label>
        <select
          value={bloodType}
          onChange={(e) => {
            const v = e.target.value;
            setBloodType(v);
            save({ enabled, bloodType: v, contact });
          }}
          className="input sm:w-40"
        >
          <option value="">Unknown</option>
          {BLOOD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Overrides any blood type derived from lab records.
        </p>
      </div>

      <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
        <label className="label">Emergency contact</label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            value={contact.name}
            placeholder="Name"
            aria-label="Emergency contact name"
            onChange={(e) =>
              setContact((c) => ({ ...c, name: e.target.value }))
            }
            onBlur={() => save({ enabled, bloodType, contact })}
            className="input"
          />
          <input
            value={contact.phone}
            placeholder="Phone"
            aria-label="Emergency contact phone"
            inputMode="tel"
            onChange={(e) =>
              setContact((c) => ({ ...c, phone: e.target.value }))
            }
            onBlur={() => save({ enabled, bloodType, contact })}
            className="input"
          />
          <input
            value={contact.relation}
            placeholder="Relationship (e.g. Spouse)"
            aria-label="Emergency contact relationship"
            onChange={(e) =>
              setContact((c) => ({ ...c, relation: e.target.value }))
            }
            onBlur={() => save({ enabled, bloodType, contact })}
            className="input sm:col-span-2"
          />
        </div>
      </div>
    </div>
  );
}
