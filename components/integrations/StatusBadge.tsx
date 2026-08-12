import type { StatusTone } from "@/lib/integrations/source-state";

// The ONE tint map for integration status/outcome tones (#1772). Before this, the
// same three states wore different colours on the grid card, the setup-page status
// card, and Review's card. The pure layer decides the semantic tone; this is the only
// place a tone becomes classes, so the family cannot drift again. Sibling to
// NOTICE_TONE (components/Notice.tsx), which owns the tinted-BLOCK map.
export const STATUS_TONE: Record<StatusTone, string> = {
  good: "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  caution: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  bad: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  neutral: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
};

// The matching TEXT tone, for an outcome line or an icon that sits on the page rather
// than inside a tinted pill.
export const STATUS_TEXT_TONE: Record<StatusTone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  caution: "text-amber-600 dark:text-amber-400",
  bad: "text-rose-600 dark:text-rose-400",
  neutral: "text-slate-500 dark:text-slate-400",
};

export default function StatusBadge({
  label,
  tone,
  icon,
  testid,
}: {
  label: string;
  tone: StatusTone;
  icon?: React.ReactNode;
  testid?: string;
}) {
  return (
    <span
      className={`badge inline-flex items-center gap-1 ${STATUS_TONE[tone]}`}
      data-testid={testid}
    >
      {icon}
      {label}
    </span>
  );
}
