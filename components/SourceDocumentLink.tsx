import Link from "next/link";
import { importHref } from "@/lib/hrefs";
import { sourceDocumentId } from "@/lib/record-format";

// Turns an item's visible identity into a source-document link when provenance
// exists. Manual and integration-owned items render byte-for-byte as their plain
// children; callers do not need parallel conditional markup.
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
