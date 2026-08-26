import Link from "next/link";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

export default function OverlayDestination({
  href,
  label,
  children,
  "data-testid": testId,
}: {
  href: AppRoute;
  label: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div className="group relative h-full">
      <Link
        href={href}
        aria-label={label}
        data-testid={testId}
        className="absolute inset-0 z-0 rounded-xl focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500"
      />
      <div
        className="pointer-events-none relative z-10 h-full"
        data-overlay-destination-content=""
      >
        {children}
      </div>
    </div>
  );
}
