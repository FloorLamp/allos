export default function VisualizationDetails({
  label,
  items,
  "data-testid": testId,
}: {
  label: string;
  items: readonly string[];
  "data-testid"?: string;
}) {
  const details = items.filter(Boolean);
  if (details.length === 0) return null;

  return (
    <details
      className="mt-2 text-xs text-slate-500 dark:text-slate-400"
      data-testid={testId}
    >
      <summary className="button-control min-h-11! min-w-11! w-fit max-w-full cursor-pointer list-none whitespace-normal text-left text-link marker:hidden">
        {label}
      </summary>
      <ul className="mt-1 space-y-0.5 pl-3">
        {details.map((detail, index) => (
          <li key={`${index}:${detail}`}>{detail}</li>
        ))}
      </ul>
    </details>
  );
}
