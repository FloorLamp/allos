import ts from "typescript";

/**
 * Every comment range in a source file, from a real TypeScript parse.
 *
 * A raw scanner cannot reliably distinguish division from a regular expression or
 * resume an interpolated template. Parser trivia keeps those grammar decisions in one
 * shared place for source analysers that must fail closed rather than hide code.
 */
export function parsedCommentRanges(
  rel: string,
  src: string
): [number, number][] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const diagnostics = (
    sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics?.length) {
    const first = diagnostics[0]!;
    const at = sf.getLineAndCharacterOfPosition(first.start ?? 0);
    throw new Error(
      `Comment scan could not parse ${rel}:${at.line + 1}:${at.character + 1}: ` +
        ts.flattenDiagnosticMessageText(first.messageText, "\n")
    );
  }

  const out: [number, number][] = [];
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      const at = node.getFullStart();
      // `getLeadingCommentRanges` starts after a line break except at position zero;
      // trailing ranges catch JSX `{/* … */}` and end-of-line comments at the token's
      // full start. Their union is the file's trivia, including end-of-file trivia.
      for (const range of [
        ...(ts.getTrailingCommentRanges(src, at) ?? []),
        ...(ts.getLeadingCommentRanges(src, at) ?? []),
      ]) {
        if (seen.has(range.pos)) continue;
        seen.add(range.pos);
        out.push([range.pos, range.end]);
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return out;
}

/** Blank parser-authenticated comments in place, preserving lines and literals. */
export function stripCommentsParsed(rel: string, src: string): string {
  const out = src.split("");
  for (const [from, to] of parsedCommentRanges(rel, src))
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  return out.join("");
}
