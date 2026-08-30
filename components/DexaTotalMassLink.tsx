import Link from "next/link";
import { normalizeCanonicalKey } from "@/lib/canonical-name";
import { metricDetailHref } from "@/lib/hrefs";

const TOTAL_MASS_KEYS = new Set(
  ["Total Mass", "Total Mass (g)"].map(normalizeCanonicalKey)
);

// #2766's render-only exception. `instead` remains a curated-result name.
export default function DexaTotalMassLink({
  name,
  testId,
}: {
  name: string;
  testId: string;
}) {
  if (!TOTAL_MASS_KEYS.has(normalizeCanonicalKey(name))) return null;
  return (
    <Link
      href={metricDetailHref("weight")}
      data-testid={testId}
      className="mt-0.5 inline-block text-xs text-brand-700 hover:underline dark:text-brand-400"
    >
      See Weight
    </Link>
  );
}
