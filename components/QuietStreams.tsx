import Link from "next/link";
import { IconDeviceWatchOff } from "@tabler/icons-react";
import type { QuietStreamRow } from "@/lib/queries/continuous-streams";

// Data → Review: a provider that is syncing green while one of its continuous data
// streams has gone quiet (#2146) — the watch off the wrist while the phone keeps
// pushing daily aggregates.
//
// CALM ON PURPOSE, and the visual language carries the tier. The escalated card above
// is rose and titled "Needs attention"; this one is slate, because nothing is broken:
// the connection is healthy, and the app is reporting an observation about data it can
// see stopped. Heart rate is an observation domain — nobody committed to wearing a
// watch — so this is coaching tier, classes 2/3 only.
//
// NO SEND-SHAPED AFFORDANCE, ANYWHERE. There is no "remind me", no "notify", no
// enable-alerts toggle and no dismiss-to-snooze here. The contact-consent rule
// (docs/internals/findings.md §2) is one-directional: the system may reduce contact
// unilaterally and may never increase it without the user's consent. The one send in
// this family — #2161's bedtime wear reminder — exists only behind an explicit
// Settings → Notifications opt-in, which is where that consent is given and the only
// place it may be offered.
//
// The single link goes to the provider's own setup page, which is where sync history
// and controls already live. It offers nothing new, and that is the point.
export default function QuietStreams({ rows }: { rows: QuietStreamRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="card" data-testid="quiet-streams">
      <div className="mb-3 flex items-center gap-2">
        <IconDeviceWatchOff
          className="h-5 w-5 text-slate-500 dark:text-slate-400"
          stroke={1.75}
        />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          A device stopped sending
        </h2>
      </div>
      <ul className="space-y-3">
        {rows.map((row) => (
          <li
            // The date-scoped identity from the pure model (quietStreamDedupeKey), so
            // the rendered key and any future suppression entry are the same string.
            key={row.key}
            data-testid={`quiet-stream-${row.id ?? row.provider}`}
            className="rounded-lg border border-black/10 bg-slate-50/60 p-3 dark:border-white/10 dark:bg-slate-900/40"
          >
            <p className="font-medium text-slate-800 dark:text-slate-100">
              {row.title}
            </p>
            {row.detail && (
              <p className="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">
                {row.detail}
              </p>
            )}
            {row.href && (
              <Link
                href={row.href}
                className="mt-2 inline-block text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                {row.provider} sync history →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
