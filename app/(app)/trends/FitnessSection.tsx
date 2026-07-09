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
export default function FitnessSection() {
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
          { id: "strength", label: "Strength", content: <StrengthSection /> },
          { id: "cardio", label: "Cardio", content: <CardioSection /> },
          { id: "sport", label: "Sport", content: <SportSection /> },
        ]}
      />
    </div>
  );
}
