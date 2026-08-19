// The dashboard projection of an Upcoming item keeps the owning model's key.
// Both the candidate gather and the Ahead resolver use these helpers so a horizon
// row cannot accidentally acquire a parallel identity namespace.

export function dashboardAttentionCandidateId(key: string): string {
  return `attention.fact:${key}`;
}

export function dashboardAttentionFactKey(key: string): string {
  return `upcoming.${key}`;
}
