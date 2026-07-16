import Link from "next/link";
import { IconArrowRight, IconUsers } from "@tabler/icons-react";
import { dismissProfileOrientation } from "@/app/(app)/onboarding/actions";
import type { OnboardingDataPresence } from "@/lib/onboarding";

const DOMAIN_LABELS: Array<
  [Exclude<keyof OnboardingDataPresence, "caregiving">, string]
> = [
  ["medicalRecords", "medical records"],
  ["medications", "medications"],
  ["fitness", "training history"],
  ["metricsLabs", "metrics or labs"],
  ["preventiveCare", "upcoming care"],
];

export default function ProfileOrientationCard({
  profileName,
  access,
  attentionCount,
  presence,
}: {
  profileName: string;
  access: "read" | "write";
  attentionCount: number;
  presence: OnboardingDataPresence;
}) {
  const domains = DOMAIN_LABELS.filter(([key]) => presence[key]).map(
    ([, label]) => label
  );

  return (
    <section
      className="card mb-6 border-l-4 border-l-sky-500 dark:border-l-sky-400"
      data-testid="profile-orientation-card"
      aria-label={`Orientation for ${profileName}`}
    >
      <div className="flex items-start gap-3">
        <IconUsers
          className="mt-0.5 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            You’re viewing {profileName}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            This login has {access === "write" ? "read and write" : "read-only"}{" "}
            access.
            {domains.length > 0
              ? ` The profile already contains ${domains.join(", ")}.`
              : " The profile does not have a starting record yet."}{" "}
            {attentionCount > 0
              ? `${attentionCount} item${attentionCount === 1 ? "" : "s"} currently need attention.`
              : "Nothing currently needs attention."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              href="/timeline"
              className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              Review the timeline <IconArrowRight className="h-4 w-4" />
            </Link>
            {access === "write" && (
              <Link
                href="/data?section=import"
                className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                Add or import data
              </Link>
            )}
            <form action={dismissProfileOrientation}>
              <button
                type="submit"
                className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                Got it
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
