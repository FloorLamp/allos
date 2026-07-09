import Link from "next/link";
import NavTabs from "@/components/NavTabs";
import StrengthSection from "../training/StrengthSection";
import CardioSection from "../training/CardioSection";
import SportSection from "../training/SportSection";

const FTABS = ["strength", "cardio", "sport"] as const;
type FitnessTab = (typeof FTABS)[number];

function parseFtab(value: string | undefined): FitnessTab {
  return FTABS.includes(value as FitnessTab)
    ? (value as FitnessTab)
    : "strength";
}

// The Trends hub's Fitness section. Reuses the Training page's Strength / Cardio /
// Sport section components verbatim (est. 1RM per lift, cardio records, weekly
// volume, sport summaries). These manage their own full-history views, so they
// aren't windowed by the shared range — the note makes that explicit. The whole
// section is hidden by the hub for age-restricted profiles (isTrainingRestricted),
// the same gate the Journal/Training nav uses, so it's never rendered for them.
//
// #105: the nested strip is URL-driven (?ftab=), and only the active nested
// section is built server-side — the page reads `ftab` and threads it down so
// the full-history training aggregations don't all run on every Fitness view.
export default function FitnessSection({ ftab }: { ftab?: string }) {
  const active = parseFtab(ftab);
  const section =
    active === "cardio" ? (
      <CardioSection />
    ) : active === "sport" ? (
      <SportSection />
    ) : (
      <StrengthSection />
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Strength, cardio, and sport progress (full history).{" "}
        <Link
          href="/training"
          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          Full Training →
        </Link>
      </p>
      <NavTabs
        paramKey="ftab"
        tabs={[
          { id: "strength", label: "Strength" },
          { id: "cardio", label: "Cardio" },
          { id: "sport", label: "Sport" },
        ]}
      >
        {section}
      </NavTabs>
    </div>
  );
}
