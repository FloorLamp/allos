import Link from "next/link";
import { IconArrowRight, IconChecklist } from "@tabler/icons-react";
import { dismissOnboardingChecklist } from "@/app/(app)/onboarding/actions";
import { MEDICATIONS_HREF, type AppRoute } from "@/lib/hrefs";
import {
  remainingOnboardingChecklistSuggestions,
  type OnboardingChecklistCompletion,
  type OnboardingChecklistSuggestion,
  type OnboardingFocus,
} from "@/lib/onboarding";

interface ChecklistItem {
  label: string;
  benefit: string;
  href: AppRoute;
  mobileOnly?: boolean;
}

const CHECKLIST_TASKS: Record<OnboardingChecklistSuggestion, ChecklistItem> = {
  "medical-records": {
    label: "Import a health record",
    benefit: "Bring medications, lab results, and history together for review.",
    href: "/data?section=import",
  },
  medications: {
    label: "Check your medications",
    benefit: "Confirm what you take before choosing which reminders you want.",
    href: MEDICATIONS_HREF,
  },
  fitness: {
    label: "Connect an app or device",
    benefit: "Sync workouts and build a useful training history automatically.",
    href: "/data?section=import#integrations",
  },
  "metrics-labs": {
    label: "Import medical data",
    benefit:
      "See results, ranges, and trends alongside your other health data.",
    href: "/data?section=import",
  },
  "preventive-care": {
    label: "Add your next appointment",
    benefit: "Keep the visit date and preparation details easy to find.",
    href: "/records/history/visits",
  },
  caregiving: {
    label: "Review profiles and access",
    benefit:
      "Make sure each person’s information stays with the right profile.",
    href: "/household",
  },
  explore: {
    label: "Add emergency details",
    benefit: "Keep essential information ready when you need it, even offline.",
    href: "/profile#emergency",
    mobileOnly: true,
  },
  notifications: {
    label: "Set up notifications",
    benefit:
      "Choose where reminders should arrive and send a test notification.",
    href: "/settings/notifications",
  },
};

export default function OnboardingChecklist({
  focuses,
  completion,
}: {
  focuses: readonly OnboardingFocus[];
  completion: OnboardingChecklistCompletion;
}) {
  const tasks = remainingOnboardingChecklistSuggestions(focuses, completion)
    .map((suggestion) => CHECKLIST_TASKS[suggestion])
    // Keep mobile-only suggestions last so a hidden desktop row cannot leave
    // the first visible row with divider/padding intended for a later item.
    .sort(
      (a, b) => Number(Boolean(a.mobileOnly)) - Number(Boolean(b.mobileOnly))
    );

  if (tasks.length === 0) return null;
  const mobileOnly = tasks.every((task) => task.mobileOnly);

  return (
    <section
      className={`card mb-6 border-l-4 border-l-emerald-500 dark:border-l-emerald-400 ${
        mobileOnly ? "md:hidden" : ""
      }`}
      data-testid="onboarding-checklist"
      aria-label="Suggested next steps"
    >
      <div className="mb-3 flex items-start gap-3">
        <IconChecklist
          className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            A few useful next steps
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Pick what helps now and leave the rest for later. You do not need to
            complete every suggestion.
          </p>
        </div>
      </div>
      <div className="divide-y divide-black/5 dark:divide-white/10">
        {tasks.slice(0, 4).map((task) => (
          <Link
            key={task.label}
            href={task.href}
            className={`group items-center justify-between gap-3 py-3 first:pt-0 ${
              task.mobileOnly ? "flex md:hidden" : "flex"
            }`}
          >
            <span>
              <span className="block text-sm font-medium text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-400">
                {task.label}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                {task.benefit}
              </span>
            </span>
            <IconArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
          </Link>
        ))}
      </div>
      <form action={dismissOnboardingChecklist} className="mt-3">
        <button
          type="submit"
          className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          Hide these suggestions
        </button>
      </form>
    </section>
  );
}
