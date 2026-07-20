import type { ReactNode } from "react";

// A page-level card that groups several related pieces of reusable content.
// Children own their controls and domain copy; this component owns the shared
// surface, hierarchy, and dividers so composing widgets does not create nested
// cards or a stack of unrelated-looking panels.
export default function CardGroup({
  title,
  description,
  action,
  children,
  className,
  "data-testid": testId,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <section
      className={["card", className].filter(Boolean).join(" ")}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function CardGroupSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "mt-5 border-t border-black/5 pt-5 dark:border-white/5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
