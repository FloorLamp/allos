"use client";

import { useState } from "react";
import { IconArrowRight, IconCheck } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import type { OnboardingProfilePath } from "@/lib/onboarding";
import { deferOnboarding, saveOnboardingProfilePath } from "./actions";

export default function ProfilePathChoices({
  selected,
  readOnly,
}: {
  selected: OnboardingProfilePath | null;
  readOnly: boolean;
}) {
  const [advancing, setAdvancing] = useState(false);

  return (
    <div className="space-y-4">
      <form action={saveOnboardingProfilePath} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="relative flex cursor-pointer items-start rounded-xl border border-black/10 p-3 pr-10 transition hover:border-brand-300 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-400/50 dark:border-white/10 dark:hover:border-brand-500/50 dark:has-[:checked]:border-brand-500/60 dark:has-[:checked]:bg-brand-500/10">
            <input
              type="radio"
              name="profile_path"
              value="self"
              defaultChecked={selected === "self"}
              disabled={readOnly || advancing}
              onChange={(event) => {
                setAdvancing(true);
                event.currentTarget.form?.requestSubmit();
              }}
              className="peer absolute top-3 right-3 h-5 w-5 cursor-pointer appearance-none rounded-full border border-slate-300 bg-white transition checked:border-brand-600 checked:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50 disabled:cursor-default dark:border-slate-600 dark:bg-ink-900 dark:checked:border-brand-500 dark:checked:bg-brand-500"
            />
            <span className="pointer-events-none absolute top-3 right-3 flex h-5 w-5 items-center justify-center text-white opacity-0 transition peer-checked:opacity-100">
              <IconCheck
                className="h-3.5 w-3.5"
                stroke={2.5}
                aria-hidden="true"
              />
            </span>
            <span>
              <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                Set up my own profile
              </span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                Personalize the dashboard for your own health information.
              </span>
            </span>
          </label>
          <label className="relative flex cursor-pointer items-start rounded-xl border border-black/10 p-3 pr-10 transition hover:border-brand-300 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-400/50 dark:border-white/10 dark:hover:border-brand-500/50 dark:has-[:checked]:border-brand-500/60 dark:has-[:checked]:bg-brand-500/10">
            <input
              type="radio"
              name="profile_path"
              value="caregiving"
              defaultChecked={selected === "caregiving"}
              disabled={readOnly || advancing}
              onChange={(event) => {
                setAdvancing(true);
                event.currentTarget.form?.requestSubmit();
              }}
              className="peer absolute top-3 right-3 h-5 w-5 cursor-pointer appearance-none rounded-full border border-slate-300 bg-white transition checked:border-brand-600 checked:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50 disabled:cursor-default dark:border-slate-600 dark:bg-ink-900 dark:checked:border-brand-500 dark:checked:bg-brand-500"
            />
            <span className="pointer-events-none absolute top-3 right-3 flex h-5 w-5 items-center justify-center text-white opacity-0 transition peer-checked:opacity-100">
              <IconCheck
                className="h-3.5 w-3.5"
                stroke={2.5}
                aria-hidden="true"
              />
            </span>
            <span>
              <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                Set up someone I care for
              </span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                This profile can be tracked without giving the person a login;
                access can be granted later.
              </span>
            </span>
          </label>
        </div>
        {!readOnly &&
          (selected ? (
            <div className="flex justify-end">
              <SubmitButton className="btn w-36" pendingLabel="Continuing…">
                Next
              </SubmitButton>
            </div>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {advancing ? "Continuing…" : "Select an option to continue."}
            </p>
          ))}
      </form>
      {!readOnly && (
        <form
          action={deferOnboarding}
          data-testid="onboarding-exit-section"
          className="border-t border-black/5 pt-3 text-right dark:border-white/5"
        >
          <SubmitButton
            pendingLabel="Leaving setup…"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Set up later, take me to my dashboard
            <IconArrowRight className="h-4 w-4" aria-hidden="true" />
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
