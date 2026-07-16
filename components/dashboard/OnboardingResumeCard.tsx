import Link from "next/link";
import { IconArrowRight, IconSparkles } from "@tabler/icons-react";
import {
  hasOnboardingFirstValue,
  onboardingFocusDef,
  type OnboardingDataPresence,
  type OnboardingState,
} from "@/lib/onboarding";

export default function OnboardingResumeCard({
  state,
  presence,
}: {
  state: OnboardingState;
  presence: OnboardingDataPresence;
}) {
  const hasFirstValue = hasOnboardingFirstValue(state.focuses, presence);
  const next = !state.profilePath
    ? "Choose who this profile is for"
    : state.focuses.length === 0
      ? "Choose what matters most"
      : !state.basicsComplete
        ? "Add the profile basics that shape ranges and reminders"
        : !hasFirstValue
          ? onboardingFocusDef(state.focuses[0]).actionLabel
          : !state.layoutReviewed
            ? "Review the recommended dashboard layout"
            : !state.notificationsReviewed
              ? "Choose what notifications should mean for this profile"
              : "Review setup and open your personalized dashboard";

  return (
    <section
      data-testid="onboarding-resume-card"
      className="card mb-6 border-l-4 border-l-brand-500 dark:border-l-brand-400"
      aria-label="Finish setting up this profile"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <IconSparkles
            className="mt-0.5 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
            aria-hidden="true"
          />
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Finish setting up this profile
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {next}. Setup is resumable, and advanced fields can wait.
            </p>
          </div>
        </div>
        <Link
          href="/onboarding"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Continue setup <IconArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
