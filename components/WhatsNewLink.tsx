import Link from "next/link";

// The ONE "What's new" affordance (issue #1421), rendered by both places the app
// version already shows: the shared sidebar footer (so every viewport carries it —
// the responsive-surfaces rule) and the Settings index footer. Keeping it a
// single component means the link text, the route, and the unread dot can't drift
// between the two.
//
// The dot is the whole unread hint: no badge count, no toast, no notification, no
// finding. `unseen` is the verdict from the ONE pure comparison
// (hasUnseenNotes(newestNoteDate(...), storedSeenDate)) resolved by the caller —
// visiting /whats-new clears it.
//
// No "use client" of its own: it's pure presentation, so the server Settings footer
// renders it directly and the client sidebar pulls it into the client bundle.
export default function WhatsNewLink({
  unseen,
  onNavigate,
  className,
}: {
  unseen: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <Link
      href="/whats-new"
      onClick={onNavigate}
      data-testid="whats-new-link"
      className={`inline-flex items-center gap-1.5 underline-offset-2 transition hover:text-slate-700 hover:underline dark:hover:text-slate-200 ${className ?? ""}`}
    >
      What&apos;s new
      {unseen && (
        <span
          data-testid="whats-new-dot"
          aria-label="Unread release notes"
          role="status"
          className="inline-block size-1.5 rounded-full bg-emerald-500"
        />
      )}
    </Link>
  );
}
