import type { ReactNode } from "react";

// THE ONE INLINE FORM FAILURE (#3750). Twenty-five forms had hand-written the
// same paragraph — `role="alert"`, one text size, the rose danger pair — and the
// copies had begun to drift in size and dark treatment. This owns the semantic
// element, the live-region role and the paint; the caller owns only the sentence.
//
// NULLABLE BY CONSTRUCTION, because every one of those call sites was already a
// `{error && (…)}` conditional and half of them spelled it differently. Passing an
// empty message renders nothing, so the conditional lives here once instead of at
// each site — and a site that needs the element to EXIST while empty (for a live
// region that announces a later arrival) is not this component's job.
//
// No tone, size, surface or className prop. #3275 still owns whether a
// quick-sheet failure is inline, a toast, or both; this owns only how an inline
// one renders once that decision is made.
export default function InlineError({
  children,
  // For `aria-describedby` on the field the failure is about.
  id,
  "data-testid": testId,
}: {
  children?: ReactNode;
  id?: string;
  "data-testid"?: string;
}) {
  if (!children) return null;
  return (
    <p
      role="alert"
      id={id}
      data-testid={testId}
      className="text-sm text-rose-600 dark:text-rose-400"
    >
      {children}
    </p>
  );
}
