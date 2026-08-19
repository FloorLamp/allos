// The seven Bristol stool-form glyphs (issue #2785).
//
// One style family by construction: every glyph is a 28×28 viewBox drawn in
// `currentColor` at stroke width 1.5, so they inherit the button's colour and work in
// both themes without a second palette. They are DECORATIVE — `aria-hidden`, always —
// because the accessible name of a Bristol button is the scale's own description, and
// a glyph that also announced itself would say it twice.
//
// The geometry is the issue's own sketch, refined only where a curve read badly at
// 28px. The shapes carry real information — lumps, cracks, ragged edges, liquid — so
// they are not interchangeable decoration and a swap would change what the button
// claims.

import { bristolStoolType } from "@/lib/bristol-stool";

const PATHS: Record<number, React.ReactNode> = {
  // 1 — separate hard lumps
  1: (
    <>
      <ellipse cx="8" cy="9" rx="3" ry="2.6" />
      <ellipse cx="17" cy="7.5" rx="2.7" ry="2.3" />
      <ellipse cx="21" cy="14" rx="2.9" ry="2.5" />
      <ellipse cx="12" cy="15.5" rx="3.1" ry="2.7" />
      <ellipse cx="8" cy="21.5" rx="2.7" ry="2.3" />
      <ellipse cx="17.5" cy="21" rx="3" ry="2.5" />
    </>
  ),
  // 2 — lumpy sausage
  2: (
    <>
      <rect x="3.5" y="9" width="21" height="10" rx="5" />
      <path
        d="M10 9.3 c1.2 2.8 1.2 6.6 0 9.4 M15.5 9.3 c1.2 2.8 1.2 6.6 0 9.4 M20.5 9.6 c1 2.4 1 5.2 0 7.6"
        opacity=".65"
      />
    </>
  ),
  // 3 — sausage with surface cracks
  3: (
    <>
      <rect x="3.5" y="9" width="21" height="10" rx="5" />
      <path
        d="M8.5 11 l1.5 2.4 M13.5 10.6 l-1.2 2.8 M18.5 11.1 l1.3 2.5 M11 16.2 l1.4 1.7 M16.5 15.8 l-1.2 1.9 M21 15.5 l1 1.6"
        opacity=".8"
      />
    </>
  ),
  // 4 — smooth soft sausage
  4: <path d="M5 19.5 Q6 11.5 12.5 10 T23 9.5" strokeWidth="6.5" />,
  // 5 — soft blobs, clear-cut edges
  5: (
    <>
      <ellipse cx="9" cy="11" rx="3.6" ry="3" />
      <ellipse cx="19" cy="9.5" rx="3.2" ry="2.7" />
      <ellipse cx="14" cy="19" rx="4" ry="3.2" />
    </>
  ),
  // 6 — mushy, ragged edges.
  //
  // The issue's sketch drew the raggedness with a dash pattern. A dash pattern is
  // chart VOCABULARY here (components/chart-scaffold.tsx owns the named ones, and
  // lib/__tests__/chart-scaffold-scan.test.ts holds the line), and borrowing it for a
  // glyph would put an annotation/reference mark in an icon. The ragged edge is drawn
  // instead: a soft blob outline with short flecks breaking off it, which is what
  // "fluffy pieces with ragged edges" looks like and needs no shared pattern.
  6: (
    <>
      <path
        d="M7 16 q-2-3 1-5 q0-3 3-3 q1-3 4-2 q3-2 5 0 q3 0 3 3 q3 2 1 5 q1 3-2 4 q-1 3-4 2 q-3 2-5 0 q-3 1-4-2 q-3-1-2-4z"
        strokeLinejoin="round"
      />
      <path
        d="M6 12.5 l-2-1 M9 7.5 l-1-2 M15 5 l.5-2 M22 7 l2-1.5 M24.5 13 l2 .5 M22 21 l2 1.5 M14 24.5 l0 2 M7 21.5 l-2 1.5"
        opacity=".7"
      />
    </>
  ),
  // 7 — entirely liquid
  7: (
    <path d="M5 10.5 q2-2 4 0 t4 0 t4 0 t4 0 M5 15.5 q2-2 4 0 t4 0 t4 0 t4 0 M5 20.5 q2-2 4 0 t4 0 t4 0 t4 0" />
  ),
};

/**
 * The glyph for a Bristol type. Renders nothing for a value the scale does not name,
 * so an eighth button cannot be drawn even by a caller that made one up.
 */
export default function BristolStoolIcon({
  type,
  className,
}: {
  type: number;
  className?: string;
}) {
  if (!bristolStoolType(type)) return null;
  return (
    <svg
      viewBox="0 0 28 28"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[type]}
    </svg>
  );
}
