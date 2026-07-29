import { describe, expect, it } from "vitest";
import {
  defaultAnnotationVisibility,
  parseAnnotationVisibility,
  serializeAnnotationVisibility,
} from "@/lib/trend-annotation-visibility";

describe("trend annotation visibility", () => {
  it("defaults every annotation kind to visible", () => {
    expect(defaultAnnotationVisibility()).toEqual({
      medication: true,
      appointment: true,
      situation: true,
      protocol: true,
    });
  });

  it("round-trips disabled kinds", () => {
    const enabled = {
      ...defaultAnnotationVisibility(),
      medication: false,
      protocol: false,
    };
    expect(
      parseAnnotationVisibility(serializeAnnotationVisibility(enabled))
    ).toEqual(enabled);
  });

  it("ignores corrupt payloads and unknown future or stale kinds", () => {
    expect(parseAnnotationVisibility("{")).toEqual(
      defaultAnnotationVisibility()
    );
    expect(
      parseAnnotationVisibility(
        JSON.stringify({ disabled: ["protocol", "retired-kind"] })
      )
    ).toEqual({
      medication: true,
      appointment: true,
      situation: true,
      protocol: false,
    });
  });
});
