import { redirect } from "next/navigation";
import BackLink from "@/components/BackLink";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { isAdultForClinical } from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings";
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
  // The battery uses adult-population norms. Logging and the rest of Training are
  // age-neutral; this route alone requires a known adult age.
  const { profile } = await requireSession();
  if (!isAdultForClinical(getProfileAge(profile.id))) redirect("/training");

  return (
    // `wide`, not `reading` (#3234). The battery is a 13-tile `lg:grid-cols-4`
    // board, which is a dense multi-column page and not prose — and it is the
    // width it had as a tab on /training, which also declares `wide`. The route
    // move (#2894) gave it a 768px reading measure AND left the view's own
    // `PageContainer` nested inside, so the tiles came out ~170px on desktop and
    // each one's title painted through its category chip. ONE container owns the
    // page width; the view below carries none.
    <PageContainer width="wide" className="mx-auto">
      <BackLink href="/training" label="Training" />
      <PageHeader
        title="Fitness check"
        subtitle="Record and re-check the tests behind your fitness age."
      />
      <FitnessCheckSection />
    </PageContainer>
  );
}
