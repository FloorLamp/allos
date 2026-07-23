// PURE view-model for the shared photo browse/compare surfaces (#1119):
// PhotoGallery (browse) and PhotoTimeline (compare) are siblings over this one
// model (#221 — one photo core, two views), so the domain-selector gating, the
// within-domain series filter, the date grouping, and the compare-pair default
// are each computed exactly once and unit-tested in
// lib/__tests__/photo-gallery-model.test.ts.

export interface GalleryPhoto {
  id: number;
  date: string; // YYYY-MM-DD
  // The series this photo belongs to within its domain (pose for physique, a
  // lesion id for skin, an episode for symptom). null = unclassified.
  seriesKey: string | null;
  url: string; // full image (lightbox only — the grid reads thumbUrl)
  thumbUrl: string;
  caption: string | null;
  // Factual context line (e.g. the physique weight snapshot). Never derived
  // judgment — the no-AI / no-score stance.
  meta: string | null;
}

export interface GalleryDomain<P extends GalleryPhoto = GalleryPhoto> {
  key: string;
  label: string;
  photos: P[];
  // Series sub-filter chips for this domain (pose names, lesion labels, …).
  series: { key: string; label: string }[];
}

// Only domains the profile actually HAS photos in are selectable (#1042-style
// gating — an empty selector option is dead UI). Order is preserved.
export function selectableDomains<P extends GalleryPhoto>(
  domains: readonly GalleryDomain<P>[]
): GalleryDomain<P>[] {
  return domains.filter((d) => d.photos.length > 0);
}

// Within a domain, narrow to one series; null = the whole collection.
export function filterBySeries<P extends GalleryPhoto>(
  photos: readonly P[],
  seriesKey: string | null
): P[] {
  if (seriesKey == null) return [...photos];
  return photos.filter((p) => p.seriesKey === seriesKey);
}

// Grid order: most-recent-first, date-grouped (ties broken by id desc so the
// order is stable).
export function dateGroups<P extends GalleryPhoto>(
  photos: readonly P[]
): { date: string; photos: P[] }[] {
  const sorted = [...photos].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id
  );
  const groups: { date: string; photos: P[] }[] = [];
  for (const p of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === p.date) last.photos.push(p);
    else groups.push({ date: p.date, photos: [p] });
  }
  return groups;
}

// Chronological order for the compare timeline: oldest → newest.
export function timelineOrder<P extends GalleryPhoto>(
  photos: readonly P[]
): P[] {
  return [...photos].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id
  );
}

// Default compare pair over a chronological series: first vs latest. Null when
// there's nothing to compare (fewer than 2 photos).
export function defaultComparePair(
  count: number
): { a: number; b: number } | null {
  if (count < 2) return null;
  return { a: 0, b: count - 1 };
}

// Lightbox paging within the current filtered set (no wrap-around).
export function lightboxNeighbors(
  index: number,
  count: number
): { prev: number | null; next: number | null } {
  return {
    prev: index > 0 ? index - 1 : null,
    next: index < count - 1 ? index + 1 : null,
  };
}
