import DestinationLink from "@/components/DestinationLink";
import type { AppRoute } from "@/lib/hrefs";
import type { ReactNode } from "react";

// ── ONE HEADER ROW (issue #4548) ────────────────────────────────────────────
//
// The title on the left, whatever the section offers on the right. Its `href` used to
// be REQUIRED, so a header whose trailing control is a button could not be expressed
// and the component had two consumers while 23 hand-rolled rows shipped the same
// arrangement in three alignments and four margins.
//
// THE PAGE LINK IS NOW THE OPTIONAL HALF, WHICH IS A TYPE AND NOT A FLAG. The old
// spelling was a required `href` plus a `showPageLink` boolean saying to ignore it —
// two fields describing one fact, with the wrong combination (no link, but an href
// anyway) representable. Absent `href` IS "no page link"; there is nothing left to
// police.
//
// `variant` NAMES THE HEADING'S REGISTER, and `label` is the app's uppercase eyebrow —
// the third register the 23 hand-rolls were already wearing, brought into the union
// rather than restyled. Only `card` is a page-level h2; a section and a label are both
// h3, because they head a part of a card and not the card itself.
//
// THE ROW ITSELF IS THE CONVENTION: one alignment (`items-center`) and one margin
// (`mb-3`). A caller that wants its own spacing keeps it on the section around this
// row, never on the row.
//
// THE TRAILING SLOT IS THE CHILDREN, which is the shape the 23 hand-rolls were already
// written in — the control sits inside the row's element — so adopting is a swap of the
// wrapper rather than a rewrite into a prop.
type Register = "card" | "section" | "label";

const HEADING_CLASS: Record<Register, string> = {
  card: "font-semibold text-slate-800 dark:text-slate-100",
  section: "text-sm font-semibold text-slate-700 dark:text-slate-200",
  label: "section-label",
};

export default function CardSectionHeader({
  title,
  href,
  linkLabel = "View all",
  variant = "card",
  titleHref,
  children,
}: {
  title: string;
  /** Absent when the section has no full page to go to — then there is no link. */
  href?: AppRoute;
  linkLabel?: string;
  variant?: Register;
  titleHref?: AppRoute;
  /** The trailing control: a button, a count, a link of the caller's own. */
  children?: ReactNode;
}) {
  const Heading = variant === "card" ? "h2" : "h3";
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <Heading className={HEADING_CLASS[variant]}>
        {titleHref ? (
          <DestinationLink
            href={titleHref}
            className="inline-flex items-center gap-1 text-link"
          >
            {title}
          </DestinationLink>
        ) : (
          title
        )}
      </Heading>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {children}
        {href ? (
          <DestinationLink
            href={href}
            aria-label={`${linkLabel} ${title.toLowerCase()}`}
            className="inline-flex items-center gap-1 text-xs text-link"
          >
            {linkLabel}
          </DestinationLink>
        ) : null}
      </div>
    </div>
  );
}
