// Profile subject carried in page query strings. Invalid or absent values do not
// name another profile; callers fall back to the acting profile before applying
// their own accessible/view-set authorization rules.
export function parseSubjectParam(
  value: string | string[] | undefined
): number | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const subjectId = Number(first);
  return Number.isInteger(subjectId) && subjectId > 0 ? subjectId : undefined;
}
