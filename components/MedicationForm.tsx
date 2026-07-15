"use client";

import IntakeItemForm from "@/components/IntakeItemForm";

// The medication add/edit form (#746): IntakeItemForm locked to kind="medication"
// so the Medications page always shows the prescriber / pharmacy / Rx / PRN
// identity block. Over the SAME actions the supplement form uses.
type IntakeFormProps = Omit<
  React.ComponentProps<typeof IntakeItemForm>,
  "kind"
>;

export default function MedicationForm(props: IntakeFormProps) {
  return <IntakeItemForm kind="medication" {...props} />;
}
