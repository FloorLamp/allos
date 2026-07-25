"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveHouseholdRound, sendTestHouseholdRound } from "../profile/actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The household dose round subscription (issue #1459), profile-scoped: at THIS
// profile's schedule slots, also send the doses due for the household members ticked
// below, each with an inline confirm button.
//
// The checklist offers only members this profile's login currently holds WRITE access
// to (server-resolved). Selection is always EXPLICIT — an admin reaches every profile,
// so auto-including everyone would be plainly wrong; and the stored list is re-checked
// against live grants at send time and again on every button tap, so a revoked member
// silently drops out without anyone editing this form.
export default function HouseholdRoundSettings({
  enabled,
  memberIds,
  offerable,
  telegramConfigured,
}: {
  enabled: boolean;
  memberIds: number[];
  offerable: { profileId: number; name: string }[];
  telegramConfigured: boolean;
}) {
  const router = useRouter();
  const [isOn, setIsOn] = useState(enabled);
  const [selected, setSelected] = useState<number[]>(memberIds);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  // A profile that is no login's own profile has no offerable members — the round has
  // no one to be about, so the toggle is inert and the card says why (§1).
  const inert = offerable.length === 0;

  function persist(nextOn: boolean, nextSelected: number[]) {
    runSave(async () => {
      const fd = new FormData();
      fd.set("household_round_enabled", nextOn ? "1" : "0");
      for (const id of nextSelected) {
        fd.append("household_round_members", String(id));
      }
      await saveHouseholdRound(fd);
      router.refresh();
    });
  }

  function toggleEnabled(next: boolean) {
    setIsOn(next);
    persist(next, selected);
  }

  function toggleMember(profileId: number, checked: boolean) {
    const next = checked
      ? [...selected, profileId].sort((a, b) => a - b)
      : selected.filter((id) => id !== profileId);
    setSelected(next);
    persist(isOn, next);
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTestHouseholdRound();
      setTestResult(result.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div
      id="household-round"
      className="card space-y-3"
      data-testid="household-round-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Household dose round
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        At your reminder times, also send the doses due for the people below —
        each with a confirm button, so a household round can be logged from the
        message. Their own reminders are unaffected.
      </p>

      {inert ? (
        <p
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="household-round-empty"
        >
          No one to include yet. This works once a login marks this profile as
          &ldquo;mine&rdquo; and has write access to other profiles.
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={isOn}
              onChange={(e) => toggleEnabled(e.target.checked)}
              className="h-4 w-4 accent-brand-600"
              data-testid="household-round-enabled"
            />
            Send me a household dose round
          </label>

          <fieldset className="space-y-2" data-testid="household-round-members">
            <legend className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Include
            </legend>
            {offerable.map((m) => (
              <label
                key={m.profileId}
                className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(m.profileId)}
                  onChange={(e) => toggleMember(m.profileId, e.target.checked)}
                  disabled={!isOn}
                  className="h-4 w-4 accent-brand-600"
                  data-testid={`household-round-member-${m.profileId}`}
                />
                {m.name}
              </label>
            ))}
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-secondary"
              onClick={runTest}
              disabled={testing || !isOn || selected.length === 0}
              data-testid="household-round-test"
            >
              {testing ? "Sending…" : "Send test"}
            </button>
            {!telegramConfigured && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Telegram isn&rsquo;t set up for your login yet.
              </span>
            )}
          </div>
          {testResult && (
            <p
              className="text-xs text-slate-600 dark:text-slate-300"
              data-testid="household-round-test-result"
            >
              {testResult}
            </p>
          )}
        </>
      )}
    </div>
  );
}
