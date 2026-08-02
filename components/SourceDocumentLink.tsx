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
}: {
  documentId?: number | null;
  source?: string | null;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const id = sourceDocumentId(documentId, source);
  if (id == null) return children;
  return (
    <Link
      href={importHref(id)}
      className={className}
      title="View source document"
      data-testid={testId}
    >
      {children}
    </Link>
  );
}
