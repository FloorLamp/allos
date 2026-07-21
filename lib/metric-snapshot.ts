// Compare two metric-sample end anchors without assuming every provider emits the
// same ISO spelling. Parsed instants are authoritative; the lexical fallback keeps
// deterministic behavior for legacy/local timestamps that Date cannot parse.
export function isStaleMetricSnapshot(
  storedEnd: string,
  incomingEnd: string
): boolean {
  const storedMs = Date.parse(storedEnd);
  const incomingMs = Date.parse(incomingEnd);
  if (Number.isFinite(storedMs) && Number.isFinite(incomingMs)) {
    return incomingMs < storedMs;
  }
  return incomingEnd < storedEnd;
}
