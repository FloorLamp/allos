"use client";

import IntakeItemForm from "@/components/IntakeItemForm";

// The supplement add/edit form (#746): IntakeItemForm locked to kind="supplement"
// so the Nutrition → Supplements surface never offers the medication identity
// fields or a kind toggle. Over the SAME actions the medication form uses.
type IntakeFormProps = Omit<
  React.ComponentProps<typeof IntakeItemForm>,
  "kind"
>;

export default function SupplementForm(props: IntakeFormProps) {
  return <IntakeItemForm kind="supplement" {...props} />;
}
