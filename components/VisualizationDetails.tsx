export default function VisualizationDetails({
  label,
  items,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  label: string;
  items: readonly string[];
  /**
   * The name assistive technology hears, when the visible label is the short human
   * one. A visual's full name is written for a reader who cannot see the plot, so it
   * belongs here rather than in the summary's visible text (#3896).
   */
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  const details = items.filter(Boolean);
  if (details.length === 0) return null;

  return (
    <details
      className="pointer-events-none relative z-10 mt-2 text-xs text-slate-500 dark:text-slate-400"
      data-testid={testId}
    >
      {/* No `!` on the tap floor: `button-control` already renders at 44px and sheds
          it from sm upward, and an important declaration outranks that reset at every
          width — which pinned all 18 consumers at the phone floor on desktop (#3896). */}
      <summary
        className="button-control pointer-events-auto w-fit max-w-full cursor-pointer list-none whitespace-normal text-left text-link marker:hidden"
        aria-label={ariaLabel}
      >
        {label}
      </summary>
      <ul className="pointer-events-auto mt-1 space-y-0.5 pl-3">
        {details.map((detail, index) => (
          <li key={`${index}:${detail}`}>{detail}</li>
        ))}
      </ul>
    </details>
  );
}
