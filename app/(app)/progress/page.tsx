import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { getUnitPrefs } from "@/lib/settings";
import { fmtWeight } from "@/lib/units";
import { getProgressPhotos } from "@/lib/progress-photo-write";
import type { GalleryPhoto } from "@/lib/photo/gallery-model";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";
import ProgressPhotosView from "./ProgressPhotosView";

// Physique progress photos (#1119 phase 2): pose-tagged series over the shared
// photo core — capture (onion-skin camera), browse (PhotoGallery), compare
// (PhotoTimeline). Data-gated in the nav (the `progress` relevance bit); the
// page itself never hard-blocks (#1042 posture — reachable by URL and via the
// command palette, which is the always-visible creation path).

export const metadata: Metadata = { title: "Progress photos" };

export default async function ProgressPhotosPage(props: {
  searchParams: Promise<{ new?: string }>;
}) {
  const searchParams = await props.searchParams;
  const session = await requireSession();
  const profileId = session.profile.id;
  const readOnly = session.access === "read";
  const prefs = getUnitPrefs(session.login.id);

  const rows = getProgressPhotos(profileId);
  const photos: (GalleryPhoto & { pose: string })[] = rows.map((r) => ({
    id: r.id,
    date: r.date,
    pose: r.pose,
    seriesKey: r.pose,
    url: `/api/progress-photo/${r.id}`,
    thumbUrl: `/api/progress-photo/${r.id}?thumb=1`,
    caption: r.caption,
    meta:
      r.weight_kg_snapshot != null
        ? fmtWeight(r.weight_kg_snapshot, prefs.weightUnit)
        : null,
  }));

  return (
    <PageContainer width="full" className="space-y-4">
      {/* The shared PageHeader, not a hand-rolled <h1> (issue #1416, section D):
      one heading treatment across every page, including the compact mobile size,
      so a density change lands here instead of needing a per-page sweep. */}
      <PageHeader
        title="Progress photos"
        subtitle="Pose-tagged physique photos, framed consistently with the onion-skin camera. Photos are resized and cleaned of camera metadata (location, device) when stored, and never leave this app — no share link, export, or emergency card includes them."
      />
      <ProgressPhotosView
        photos={photos}
        readOnly={readOnly}
        // The palette's "Add progress photo" action lands with ?new=1 —
        // auto-open the capture flow (the FOCUS_PARAM convention).
        autoCapture={searchParams.new != null && !readOnly}
      />
    </PageContainer>
  );
}
