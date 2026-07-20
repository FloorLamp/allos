import Link from "next/link";
import type { ImportTab } from "@/lib/import-browser";

// The import-detail records-browser tab strip (#271): one tab per non-empty
// produced type (label + count — the data the old "What it produced" card
// showed, now doubling as the navigation), plus a Providers count chip that links
// to the shared registry index (/providers, #275) — it's a chip rather than a tab
// because providers are global (not this document's owned rows). Server-rendered:
// each tab is a plain link that sets ?tab= on the document's own path, so the
// active panel is chosen server-side.
export default function ImportTabStrip({
  docId,
  tabs,
  activeKey,
  providers,
}: {
  docId: number;
  tabs: ImportTab[];
  activeKey: string | undefined;
  providers: number;
}) {
  return (
    <nav
      aria-label="Produced record types"
      data-testid="import-tab-strip"
      className="flex flex-wrap gap-2"
    >
      {tabs.map((t) => {
        const active = t.key === activeKey;
        return (
          <Link
            key={t.key}
            href={`/import/${docId}?tab=${encodeURIComponent(t.key)}`}
            aria-current={active ? "page" : undefined}
            data-testid={`import-tab-${t.key}`}
            className={`badge inline-flex items-center gap-1 transition ${
              active
                ? "bg-brand-600 text-white dark:bg-brand-500 dark:text-white"
                : "bg-slate-100 text-slate-700 hover:bg-brand-100 hover:text-brand-700 dark:bg-ink-800 dark:text-slate-200 dark:hover:bg-brand-950 dark:hover:text-brand-300"
            }`}
          >
            {t.label}{" "}
            <span className="tabular-nums font-semibold">{t.count}</span>
          </Link>
        );
      })}
      {providers > 0 && (
        <Link
          href="/records#providers"
          data-testid="import-providers-chip"
          title="Providers referenced by this import live in the shared registry."
          className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-700 transition hover:bg-brand-100 hover:text-brand-700 dark:bg-ink-800 dark:text-slate-200 dark:hover:bg-brand-950 dark:hover:text-brand-300"
        >
          Providers{" "}
          <span className="tabular-nums font-semibold">{providers}</span>
        </Link>
      )}
    </nav>
  );
}
