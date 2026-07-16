"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconArrowRight, IconSparkles } from "@tabler/icons-react";

export default function OnboardingReturnBanner({ show }: { show: boolean }) {
  const pathname = usePathname();
  if (!show || pathname === "/" || pathname === "/onboarding") return null;

  return (
    <div
      data-testid="onboarding-return-banner"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm dark:border-brand-500/25 dark:bg-brand-500/10"
    >
      <span className="inline-flex items-center gap-2 text-brand-800 dark:text-brand-200">
        <IconSparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        Your setup is saved. Return when you’re ready to continue.
      </span>
      <Link
        href="/onboarding"
        className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        Continue setup
        <IconArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
