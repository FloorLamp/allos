"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Stale-anchor bridge (#1086). Coverage gaps moved off /records to Data → Coverage,
// so an old bookmark/deep-link to `/records#coverage` no longer resolves to a
// section here. A URL fragment never reaches the server, so a next.config redirect
// can't match it — this client shim replaces the URL when it lands on the dead
// anchor. Fires once on mount; no-op for every other (or absent) hash.
export default function CoverageAnchorRedirect() {
  const router = useRouter();
  useEffect(() => {
    if (window.location.hash === "#coverage") {
      router.replace("/data?section=coverage");
    }
  }, [router]);
  return null;
}
