"use client";

import InstrumentQuestionnaire from "@/components/InstrumentQuestionnaire";
import {
  SUBSTANCE_INSTRUMENTS,
  substanceInstrumentDef,
  substanceSeverityBand,
  type SubstanceInstrument,
} from "@/lib/substance-use";
import { recordSubstanceInstrumentAction } from "./actions";

export default function SubstanceInstrumentsForm({
  defaultDate,
  initialInstrument,
}: {
  defaultDate: string;
  initialInstrument?: SubstanceInstrument;
}) {
  return (
    <InstrumentQuestionnaire
      defaultDate={defaultDate}
      initialInstrument={initialInstrument}
      instruments={SUBSTANCE_INSTRUMENTS}
      definition={substanceInstrumentDef}
      severityBand={substanceSeverityBand}
      recordAction={recordSubstanceInstrumentAction}
      idPrefix="substance-"
    />
  );
}
