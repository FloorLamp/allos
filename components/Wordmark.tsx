import { useId } from "react";
import { Outfit } from "next/font/google";
import {
  LOGO_GRADIENT_FROM,
  LOGO_GRADIENT_TO,
  LOGO_PATH,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
} from "@/lib/logo";

// Clean geometric face for the wordmark — calm and modern, to suit the
// "allostasis" idea rather than an athletic shout.
const outfit = Outfit({
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
});

// The Allos logo: the allostatic wave (stroked with the brand blue→teal gradient)
// plus the wordmark text. Shared by the desktop sidebar (app/layout.tsx), the
// mobile drawer/top bar (components/MobileNav.tsx), and the login page, so the
// logo, font, and type styling live in one place. `markClassName` sizes the mark.
export default function Wordmark({
  markClassName = "h-6 w-10",
}: {
  markClassName?: string;
}) {
  // Unique per instance: the wordmark is rendered on multiple surfaces at once
  // (the desktop sidebar and the mobile top bar both mount it), and the desktop
  // sidebar — first in DOM order — is `display:none` on phones. A shared, static
  // gradient id would make the mobile mark's `url(#…)` resolve to that hidden
  // instance, which WebKit/iOS refuses to paint from, blanking the logo on
  // mobile. useId() gives each instance its own gradient so the reference always
  // points at a visible one.
  const gradientId = useId();
  return (
    <>
      <svg
        viewBox={LOGO_VIEWBOX}
        className={`${markClassName} shrink-0`}
        fill="none"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={LOGO_GRADIENT_FROM} />
            <stop offset="1" stopColor={LOGO_GRADIENT_TO} />
          </linearGradient>
        </defs>
        <path
          d={LOGO_PATH}
          stroke={`url(#${gradientId})`}
          strokeWidth={LOGO_STROKE_WIDTH}
          strokeLinecap="round"
          strokeMiterlimit={10}
        />
      </svg>
      <span
        className={`${outfit.className} whitespace-nowrap text-2xl font-semibold tracking-tight text-slate-800 dark:text-slate-100`}
      >
        Allos
      </span>
    </>
  );
}
