"use client";

import { useRouter } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";

// A compact select whose options are server-built hrefs — the behavior of a
// segmented row of Links (navigate; server components re-read the params) in a
// phone-sized control (#2895). The href stays minted on the server, so this
// component knows nothing about any surface's URL grammar.
export default function HrefSelect({
  ariaLabel,
  value,
  options,
  className = "input h-auto w-auto py-1.5 text-sm",
}: {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string; href: AppRoute }[];
  className?: string;
}) {
  const router = useRouter();
  return (
    <select
      aria-label={ariaLabel}
      className={className}
      value={value}
      onChange={(e) => {
        const opt = options.find((o) => o.value === e.target.value);
        if (opt) router.push(opt.href);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
