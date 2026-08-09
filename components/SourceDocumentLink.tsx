import Link from "next/link";
import { importHref } from "@/lib/hrefs";
import { sourceDocumentId } from "@/lib/record-format";

// Shared explicit source-document link. Callers should label this as provenance
// (for example, "Source document") rather than wrapping an item's name, date, or
// value: an import is the item's source, not the item's detail destination.
export default function SourceDocumentLink({
  documentId,
  source,
  children,
  className = "text-brand-700 transition hover:underline dark:text-brand-300",
  testId = "source-document-link",
  role,
  onClick,
}: {
  documentId?: number | null;
  source?: string | null;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  // Set when the link is an ITEM of a menu rather than a line of a card (#2316):
  // an `<a>` inside `role="menu"` has to announce itself as a menuitem, and the
  // menu that owns it wants to close as the navigation starts.
  role?: "menuitem";
  onClick?: () => void;
}) {
  const id = sourceDocumentId(documentId, source);
  if (id == null) return children;
  return (
    <Link
      href={importHref(id)}
      className={className}
      title="View source document"
      data-testid={testId}
      role={role}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}
