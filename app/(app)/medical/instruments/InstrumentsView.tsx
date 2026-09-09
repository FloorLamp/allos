"use client";

import InstrumentQuestionnaire from "@/components/InstrumentQuestionnaire";
import {
  INSTRUMENTS,
  instrumentDef,
  instrumentItemOptions,
  severityBand,
  type Instrument,
} from "@/lib/mental-health";
import { recordInstrumentAction } from "./actions";

function questionnaireDefinition(instrument: Instrument) {
  const def = instrumentDef(instrument);
  return {
    ...def,
    entry: "in-app" as const,
    instructions: def.prompt,
    items: def.items.map((prompt, i) => ({
      prompt,
      options: instrumentItemOptions(instrument, i),
    })),
  };
}

export default function InstrumentsView({
  defaultDate,
  initialInstrument,
}: {
  defaultDate: string;
  initialInstrument?: Instrument;
}) {
  return (
    <InstrumentQuestionnaire
      defaultDate={defaultDate}
      initialInstrument={initialInstrument}
      instruments={INSTRUMENTS}
      definition={questionnaireDefinition}
      severityBand={severityBand}
      recordAction={recordInstrumentAction}
    />
  );
}
