import DashboardAtomCard from "@/components/dashboard/DashboardAtomCard";
import UsualRoutineControl, {
  type UsualRoutineControlProps,
} from "@/components/dashboard/UsualRoutineControl";

// The composed morning one-tap is its own transient action candidate. It can exist
// without a protein target, and disappears as soon as everything it names is logged.
//
// It is titled by WHAT IT DOES (#3365). "Nutrition today" headed both this offer and
// the protein readout, so the same words scrolled past twice meaning two different
// things; the readout keeps the name of the domain and the card takes the control's
// own words. Chrome comes from the one card shell every Show-everything action draws.
export function UsualRoutineAtom(props: UsualRoutineControlProps) {
  return (
    <DashboardAtomCard
      title={`Your usual ${props.window}`}
      href="/nutrition"
      testId="usual-routine-atom"
    >
      <UsualRoutineControl {...props} />
    </DashboardAtomCard>
  );
}
