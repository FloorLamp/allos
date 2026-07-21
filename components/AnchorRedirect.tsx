"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";

// Stale-anchor bridge (#1079, generalizing the #1086 CoverageAnchorRedirect). When
// a stacked-section page (`/results`, `/records`) becomes route-per-tab, an old
// bookmark or deep-link to `#<section>` no longer resolves to a section on the
// landing route. A URL fragment never reaches the server, so a next.config redirect
// can't match it — this client shim maps a known landing hash to its new route and
// `router.replace`s to it, PRESERVING any query string (so `/results?q=x#biomarkers`
// keeps its filter). Fires on mount (and whenever the hash changes); a no-op for
// every unmapped (or absent) hash. The map keys are bare fragment ids (no `#`), and
// every mapped destination is hashless so the post-replace URL can't re-trigger.
export default function AnchorRedirect({
  map,
}: {
  map: Record<string, AppRoute>;
}) {
  const router = useRouter();
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const base = hash ? map[hash] : undefined;
    if (!base) return;
    // Same-page hash → a native in-page anchor (e.g. `#emergency-card` on the Care ›
    // Overview pane, or `#biomarkers` on the Biomarkers tab). Leave it for the
    // browser to scroll; only a hash naming a DIFFERENT pane redirects.
    if (base.split(/[?#]/)[0] === window.location.pathname) return;
    const search = window.location.search; // "" or "?a=b"
    let dest: string = base;
    if (search) {
      dest = base.includes("?")
        ? `${base}&${search.slice(1)}`
        : `${base}${search}`;
    }
    router.replace(dest as AppRoute);
    // `map` is a stable module-level literal from the (server) layout; listing it
    // would only re-run this idempotent effect. Keying on `router` is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);
  return null;
}
