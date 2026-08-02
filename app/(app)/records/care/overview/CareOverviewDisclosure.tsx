"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";

export default function CareOverviewDisclosure({
  id,
  title,
  description,
  hashAliases = [],
  testId,
  children,
}: {
  id: string;
  title: string;
  description: string;
  hashAliases?: string[];
  testId: string;
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function revealHashTarget() {
      const hash = window.location.hash.slice(1);
      if (hash !== id && !hashAliases.includes(hash)) return;

      if (detailsRef.current) detailsRef.current.open = true;
      window.requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView();
      });
    }

    revealHashTarget();
    window.addEventListener("hashchange", revealHashTarget);
    return () => window.removeEventListener("hashchange", revealHashTarget);
  }, [hashAliases, id]);

  return (
    <details
      ref={detailsRef}
      id={id}
      className="group scroll-mt-36 border-b border-black/5 dark:border-white/5"
      data-testid={testId}
    >
      <summary className="flex cursor-pointer list-none items-center gap-4 px-1 py-4 outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">
            {description}
          </span>
        </span>
        <IconChevronDown className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-6 pt-2">{children}</div>
    </details>
  );
}
