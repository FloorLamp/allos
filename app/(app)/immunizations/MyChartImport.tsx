import Link from "next/link";
import { IconFileImport, IconChevronRight } from "@tabler/icons-react";

// Points at the Import page, where health-record uploads live alongside lab/scan
// documents. A MyChart "Download Summary" (CCD/XDM) or SMART Health Card imported
// there flows into the same immunizations shown on this page (and its labs/vitals
// into Clinical results), and the file becomes a managed document you can reprocess or
// delete.
export default function MyChartImport({
  compact = false,
  menuItemClass,
  onNavigate,
}: {
  compact?: boolean;
  // MENU MODE (#3408, item C). The immunizations pane folded its rare-cadence
  // actions behind a ⋯, and the import door goes with them — so this renders as
  // a `role="menuitem"` link wearing the menu's own row class rather than as a
  // bordered secondary standing above the list. Still a real <a>: the pre-
  // hydration window and "open in a new tab" both matter more here than they do
  // for a button, and it is the same href the card and the compact button use.
  menuItemClass?: string;
  onNavigate?: () => void;
}) {
  if (menuItemClass) {
    return (
      <Link
        href="/data?section=import"
        role="menuitem"
        className={menuItemClass}
        data-testid="immunization-import-link"
        onClick={onNavigate}
      >
        Import records
      </Link>
    );
  }

  if (compact) {
    return (
      <Link href="/data?section=import" className="btn-ghost text-sm">
        <IconFileImport className="h-4 w-4" stroke={1.75} />
        Import records
      </Link>
    );
  }

  return (
    <Link
      href="/data?section=import"
      className="card flex items-center gap-3 transition hover:border-brand-400 hover:bg-brand-50/40 dark:hover:bg-brand-950/30"
    >
      <IconFileImport
        className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
        stroke={1.75}
      />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-slate-800 dark:text-slate-100">
          Import from MyChart
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Upload a “Download Summary” (CCD/XDM) or SMART Health Card on the
          Import page to bring in your immunizations, labs, and vitals.
        </p>
      </div>
      <IconChevronRight
        className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
        stroke={1.75}
      />
    </Link>
  );
}
