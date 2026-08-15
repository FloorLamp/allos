import Link from "next/link";
import { redirect } from "next/navigation";
import { IconChevronLeft } from "@tabler/icons-react";
import PageContainer from "@/components/PageContainer";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import FitnessCheckSection from "../FitnessCheckSection";

export const dynamic = "force-dynamic";

// The Fitness check battery as a destination page (#2894, answering the call
// #2566 held): a quarterly activity no longer holds a permanent tab. Overview's
// strip is the standing surface — current-or-due at a glance on the page people
// actually land on — and this route is one tap behind its "Start a check"
// affordance. The retired `?tab=fitness` deep links (longevity, the retest
// finding, old bookmarks, Telegram history) redirect here from the training
// page, so nothing 404s and nothing lands on the wrong tab.
export default async function FitnessCheckPage() {
  // Adult-gated like the rest of the training hub (#489): the tab used to sit
  // behind /training's own gate, so the route keeps the exact same boundary.
  const { profile } = await requireSession();
  if (isTrainingRestricted(profile.id)) redirect("/training");

  return (
    <PageContainer width="reading" className="mx-auto">
      <Link
        href="/training"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconChevronLeft className="h-4 w-4" aria-hidden /> Training
      </Link>
      <FitnessCheckSection />
    </PageContainer>
  );
}
