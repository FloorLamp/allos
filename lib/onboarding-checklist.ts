import { MEDICATIONS_HREF, type AppRoute } from "@/lib/hrefs";
import {
  remainingOnboardingChecklistSuggestions,
  type OnboardingChecklistCompletion,
  type OnboardingChecklistSuggestion,
  type OnboardingFocus,
} from "@/lib/onboarding";

export interface OnboardingChecklistTask {
  suggestion: OnboardingChecklistSuggestion;
  label: string;
  /**
   * WHY THIS STEP IS WORTH DOING, in the reader's terms. It is the row's facts
   * column, and it came back with the per-step rows (#4362 ruling 3): the row that
   * joined every remaining label into one facts cell had nowhere to put eight of
   * these, so a person setting up the app was told WHAT to do and never why.
   */
  benefit: string;
  href: AppRoute;
  /** Advice only a phone reader can act on. See `orderedOnboardingChecklistTasks`. */
  mobileOnly?: boolean;
}

// The suggested next steps, one per #1284 suggestion key.
const CHECKLIST_TASKS: Record<
  OnboardingChecklistSuggestion,
  Omit<OnboardingChecklistTask, "suggestion">
> = {
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

/** The most steps the checklist offers at once. */
const CHECKLIST_ROW_CAP = 4;

/**
 * The remaining steps, in the order they are offered.
 *
 * MOBILE-ONLY ADVICE COMES LAST, which is a rule about READING ORDER and not about
 * chrome: a suggestion only a phone reader can act on should not lead a list a
 * desktop reader is working through. It predates the row grammar (it was written so
 * a hidden desktop row could not leave the first visible row wearing padding meant
 * for a later item) and it is restored here as the data rule it always was, in `lib/`
 * where the dashboard and its tests read the same one.
 */
export function orderedOnboardingChecklistTasks(
  focuses: readonly OnboardingFocus[],
  completion: OnboardingChecklistCompletion
): OnboardingChecklistTask[] {
  return remainingOnboardingChecklistSuggestions(focuses, completion)
    .map((suggestion) => ({ suggestion, ...CHECKLIST_TASKS[suggestion] }))
    .sort(
      (a, b) => Number(Boolean(a.mobileOnly)) - Number(Boolean(b.mobileOnly))
    )
    .slice(0, CHECKLIST_ROW_CAP);
}
