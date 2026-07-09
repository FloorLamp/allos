import Link from "next/link";
import Tabs from "@/components/Tabs";
import StrengthSection from "../training/StrengthSection";
import CardioSection from "../training/CardioSection";
import SportSection from "../training/SportSection";

// The Trends hub's Fitness section. Reuses the Training page's Strength / Cardio /
// Sport section components verbatim (est. 1RM per lift, cardio records, weekly
// volume, sport summaries). These manage their own full-history views, so they
// aren't windowed by the shared range — the note makes that explicit. The whole
// section is hidden by the hub for age-restricted profiles (isTrainingRestricted),
// the same gate the Journal/Training nav uses, so it's never rendered for them.
// Like the hub's own tab strip, only the ACTIVE inner tab's section is
// constructed (#105): the training sections run full-history aggregations, so
// building the hidden ones would execute their queries on every request. ftab is
// the ?ftab= param threaded down from the page, matching the inner Tabs paramKey.
export default function FitnessSection({ ftab }: { ftab?: string }) {
  const active = ftab === "cardio" || ftab === "sport" ? ftab : "strength";
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
      <Tabs
        paramKey="ftab"
        tabs={[
          {
            id: "strength",
            label: "Strength",
            content: active === "strength" ? <StrengthSection /> : null,
          },
          {
            id: "cardio",
            label: "Cardio",
            content: active === "cardio" ? <CardioSection /> : null,
            keepMounted: false,
          },
          {
            id: "sport",
            label: "Sport",
            content: active === "sport" ? <SportSection /> : null,
            keepMounted: false,
          },
        ]}
      />
    </div>
  );
}
