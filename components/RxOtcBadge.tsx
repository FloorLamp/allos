// The Rx / OTC badge for a medication (issue #851 items 1–2). Renders "Rx" for a
// prescription (rx=1) and "OTC" for an over-the-counter medication (rx=0), replacing
// the former hardcoded "Rx" badge. ONE component so the list row, the card, and the
// detail page can never disagree about a med's prescription status.
export default function RxOtcBadge({ rx }: { rx: number }) {
  return rx === 1 ? (
    <span
      data-testid="rx-badge"
      className="badge bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
    >
      Rx
    </span>
  ) : (
    <span
      data-testid="otc-badge"
      className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
    >
      OTC
    </span>
  );
}
