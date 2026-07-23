import Link from "next/link";
import {
  CRISIS_LEAD_LINE,
  CRISIS_FALLBACK_LINE,
  hasConfiguredCrisisResources,
  type CrisisResource,
} from "@/lib/crisis-resources";

// The shared, calm renderer for the configured crisis resources (issue #996). Used
// by BOTH the always-available passive surface (/crisis-resources) and the reactive
// inline surfacing on the instruments page — one formatter, so the two can't drift.
// Non-alarmist and non-blocking: the resource is clearly present without alarm — the
// deliberate exception to "calm by default". The signal it responds to stays with
// the profile; this component only ever renders resources, it never pushes, logs, or
// transmits anything.
//
// `resources` is already resolved (override > global > []) by the caller from THIS
// profile's settings. When empty, the neutral fallback shows — never a fabricated
// number — plus, for an admin, a pointer to configure the real list.
export default function CrisisResources({
  resources,
  isAdmin = false,
  showLead = true,
}: {
  resources: CrisisResource[];
  isAdmin?: boolean;
  showLead?: boolean;
}) {
  const configured = hasConfiguredCrisisResources(resources);
  return (
    <div className="space-y-3 text-sm" data-testid="crisis-resources">
      {showLead && <p>{CRISIS_LEAD_LINE}</p>}

      {configured ? (
        <ul className="space-y-1" data-testid="crisis-resources-list">
          {resources.map((r, i) => (
            <li key={i} className="flex flex-wrap gap-x-2">
              {r.label && <span className="font-medium">{r.label}:</span>}
              <span className="break-words">{r.contact}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="crisis-resources-fallback">{CRISIS_FALLBACK_LINE}</p>
      )}

      <p className="text-slate-600 dark:text-slate-300">
        Consider discussing how you’re feeling with a clinician.
      </p>

      {isAdmin && !configured && (
        <p
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="crisis-resources-configure-pointer"
        >
          No crisis resources are configured yet. Add your region’s crisis
          line(s) on{" "}
          <Link
            href="/settings/server"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            Settings → Server
          </Link>
          .
        </p>
      )}
    </div>
  );
}
