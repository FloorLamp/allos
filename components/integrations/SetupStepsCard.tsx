import type { ReactNode } from "react";
import { TokenRow } from "@/components/TokenRow";

// The ONE integration setup-instructions card (#3777). Calendar feed, weather,
// Oura, Strava, Withings and Health Connect each hand-built the same `card` +
// heading + `list-decimal` ordered list, so the heading scale, the step spacing
// and the phone wrapping were six independent decisions about one anatomy.
//
// Callers supply CONTENT and nothing else. Steps really do carry links,
// `<strong>` and `<code>`, so a step is a node — but the `<li>` around it, and
// the order it sits in, belong to the list. The copy-target rows two providers
// print above their steps are a typed {label, value} pair rendered through the
// shared TokenRow (#1063), not a slot the caller fills. There is no className,
// no shell variant and no spare region: a page that needs a different frame is
// not this card. Integration ACTIONS (#3745) and lead/detail copy (#3490) are
// separately owned and stay outside it.
export default function SetupStepsCard({
  title,
  tokenRows,
  steps,
  note,
}: {
  title: string;
  tokenRows?: readonly { label: string; value: string }[];
  steps: readonly ReactNode[];
  note?: ReactNode;
}) {
  return (
    <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      {tokenRows?.map((row) => (
        <TokenRow key={row.label} label={row.label} value={row.value} />
      ))}
      <ol className="list-decimal space-y-2 pl-5">
        {steps.map((step, index) => (
          // The index IS the identity here: these lists are static and ordered,
          // and step 2 is step 2.
          <li key={index}>{step}</li>
        ))}
      </ol>
      {note ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{note}</p>
      ) : null}
    </div>
  );
}
