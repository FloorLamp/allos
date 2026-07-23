// The gallery/timeline view model (#1119): domain-selector gating (only domains
// with photos are offered), the within-domain series filter, date grouping,
// the default compare pair, and lightbox paging — the pure halves PhotoGallery
// and PhotoTimeline are formatters over.

import { describe, expect, it } from "vitest";
import {
  dateGroups,
  defaultComparePair,
  filterBySeries,
  lightboxNeighbors,
  selectableDomains,
  timelineOrder,
  type GalleryDomain,
  type GalleryPhoto,
} from "../photo/gallery-model";

function photo(
  id: number,
  date: string,
  seriesKey: string | null = null
): GalleryPhoto {
  return {
    id,
    date,
    seriesKey,
    url: `/api/x/${id}`,
    thumbUrl: `/api/x/${id}?thumb=1`,
    caption: null,
    meta: null,
  };
}

describe("selectableDomains", () => {
  it("offers only domains that actually have photos, preserving order", () => {
    const domains: GalleryDomain[] = [
      {
        key: "progress",
        label: "Progress",
        photos: [photo(1, "2026-01-01")],
        series: [],
      },
      { key: "skin", label: "Skin", photos: [], series: [] },
      {
        key: "symptom",
        label: "Symptom",
        photos: [photo(2, "2026-01-02")],
        series: [],
      },
    ];
    expect(selectableDomains(domains).map((d) => d.key)).toEqual([
      "progress",
      "symptom",
    ]);
  });
  it("is empty when no domain has photos", () => {
    expect(
      selectableDomains([{ key: "p", label: "P", photos: [], series: [] }])
    ).toEqual([]);
  });
});

describe("filterBySeries", () => {
  const photos = [
    photo(1, "2026-01-01", "front"),
    photo(2, "2026-01-02", "side"),
    photo(3, "2026-01-03", "front"),
  ];
  it("partitions by series key", () => {
    expect(filterBySeries(photos, "front").map((p) => p.id)).toEqual([1, 3]);
    expect(filterBySeries(photos, "side").map((p) => p.id)).toEqual([2]);
    expect(filterBySeries(photos, "back")).toEqual([]);
  });
  it("null shows the whole collection", () => {
    expect(filterBySeries(photos, null).map((p) => p.id)).toEqual([1, 2, 3]);
  });
});

describe("dateGroups", () => {
  it("groups most-recent-first with stable intra-day order", () => {
    const groups = dateGroups([
      photo(1, "2026-01-01"),
      photo(4, "2026-01-03"),
      photo(2, "2026-01-03"),
      photo(3, "2026-01-02"),
    ]);
    expect(groups.map((g) => g.date)).toEqual([
      "2026-01-03",
      "2026-01-02",
      "2026-01-01",
    ]);
    expect(groups[0].photos.map((p) => p.id)).toEqual([4, 2]); // id desc within a day
  });
});

describe("timelineOrder / defaultComparePair", () => {
  it("orders oldest → newest and defaults to first-vs-latest", () => {
    const series = timelineOrder([
      photo(3, "2026-02-01"),
      photo(1, "2026-01-01"),
      photo(2, "2026-01-15"),
    ]);
    expect(series.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(defaultComparePair(series.length)).toEqual({ a: 0, b: 2 });
  });
  it("has nothing to compare below two photos", () => {
    expect(defaultComparePair(1)).toBeNull();
    expect(defaultComparePair(0)).toBeNull();
  });
});

describe("lightboxNeighbors", () => {
  it("pages within bounds without wrap-around", () => {
    expect(lightboxNeighbors(0, 3)).toEqual({ prev: null, next: 1 });
    expect(lightboxNeighbors(1, 3)).toEqual({ prev: 0, next: 2 });
    expect(lightboxNeighbors(2, 3)).toEqual({ prev: 1, next: null });
    expect(lightboxNeighbors(0, 1)).toEqual({ prev: null, next: null });
  });
});
