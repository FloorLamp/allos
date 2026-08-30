import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import FitnessTestTimer from "@/components/activity-form/FitnessTestTimer";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import PhotoGallery from "@/components/photo/PhotoGallery";

function expectLocked(locked: boolean) {
  expect(document.body.style.position).toBe(locked ? "fixed" : "");
  expect(document.body.style.overflow).toBe(locked ? "hidden" : "");
}

describe("overlay body scroll locks", () => {
  beforeEach(() => vi.stubGlobal("scrollTo", vi.fn()));

  it("holds for MergeConflictDialog and releases on unmount", () => {
    const view = render(
      <MergeConflictDialog
        conflicts={[]}
        members={[]}
        keeperId={1}
        units={{ weightUnit: "kg", distanceUnit: "km", temperatureUnit: "C" }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expectLocked(true);
    view.unmount();
    expectLocked(false);
  });

  it("holds only while PhotoGallery's lightbox is open", () => {
    const view = render(
      <PhotoGallery
        domains={[
          {
            key: "skin",
            label: "Skin",
            series: [],
            photos: [
              {
                id: 1,
                date: "2026-08-29",
                seriesKey: null,
                url: "/photo.jpg",
                thumbUrl: "/thumb.jpg",
                caption: null,
                meta: null,
              },
            ],
          },
        ]}
      />
    );
    expectLocked(false);
    fireEvent.click(view.getByTestId("photo-gallery-item-1"));
    expectLocked(true);
    fireEvent.click(view.getByTestId("photo-lightbox-close"));
    expectLocked(false);
  });

  it("holds only while FitnessTestTimer's takeover is expanded", () => {
    const view = render(
      <FitnessTestTimer label="Plank" testKey="plank" onFinish={() => {}} />
    );
    expectLocked(false);
    fireEvent.click(view.getByTestId("fitness-timer-plank-launch"));
    expectLocked(true);
    fireEvent.click(view.getByTestId("fitness-timer-plank-collapse"));
    expectLocked(false);
  });
});
