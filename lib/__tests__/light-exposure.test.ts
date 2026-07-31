import { describe, it, expect } from "vitest";
import {
  FAVORABLE_MAX_UV,
  FAVORABLE_MIN_UV,
  favorableLightConditions,
  hourClockLabel,
  lightExposureLine,
  uvBandLabel,
} from "@/lib/light-exposure";

// The #1723 part 1 gate. Pure — every conditions scenario is a literal.

// WMO codes: 0 clear, 2 partly cloudy, 3 overcast, 61 rain, 95 thunderstorm.
const CLEAR = 0;
const PARTLY = 2;
const OVERCAST = 3;
const RAIN = 61;

const favorable = {
  weatherCode: CLEAR,
  precipitationMm: 0,
  uvIndexMax: 4,
  hasDaylight: true,
};

describe("favorableLightConditions — the named gate", () => {
  it("a clear, dry day with usable UV is favorable", () => {
    expect(favorableLightConditions(favorable)).toBe(true);
  });

  it("a partly-cloudy day is still favorable", () => {
    expect(
      favorableLightConditions({ ...favorable, weatherCode: PARTLY })
    ).toBe(true);
  });

  it("overcast is not", () => {
    expect(
      favorableLightConditions({ ...favorable, weatherCode: OVERCAST })
    ).toBe(false);
  });

  it("rain is not, however sunny the UV reading looks", () => {
    expect(
      favorableLightConditions({
        ...favorable,
        weatherCode: RAIN,
        uvIndexMax: 6,
      })
    ).toBe(false);
  });

  it("real precipitation vetoes an otherwise clear day; a trace does not", () => {
    expect(favorableLightConditions({ ...favorable, precipitationMm: 4 })).toBe(
      false
    );
    expect(
      favorableLightConditions({ ...favorable, precipitationMm: 0.2 })
    ).toBe(true);
  });

  it("NO DATA is never favorable — silence beats a guess", () => {
    expect(favorableLightConditions({ ...favorable, weatherCode: null })).toBe(
      false
    );
    expect(favorableLightConditions({ ...favorable, uvIndexMax: null })).toBe(
      false
    );
  });

  it("no daylight window (a polar night) is not favorable", () => {
    expect(favorableLightConditions({ ...favorable, hasDaylight: false })).toBe(
      false
    );
  });

  it("UV below the floor says nothing — there is no light to speak of", () => {
    expect(
      favorableLightConditions({
        ...favorable,
        uvIndexMax: FAVORABLE_MIN_UV - 0.1,
      })
    ).toBe(false);
    expect(
      favorableLightConditions({ ...favorable, uvIndexMax: FAVORABLE_MIN_UV })
    ).toBe(true);
  });

  it("a scorching day belongs to the overexposure engine, not to encouragement", () => {
    expect(
      favorableLightConditions({ ...favorable, uvIndexMax: FAVORABLE_MAX_UV })
    ).toBe(false);
    expect(favorableLightConditions({ ...favorable, uvIndexMax: 11 })).toBe(
      false
    );
  });
});

describe("uvBandLabel / hourClockLabel", () => {
  it("names the WHO bands", () => {
    expect(uvBandLabel(1)).toBe("low");
    expect(uvBandLabel(4)).toBe("moderate");
    expect(uvBandLabel(7)).toBe("high");
    expect(uvBandLabel(9)).toBe("very high");
    expect(uvBandLabel(12)).toBe("extreme");
    expect(uvBandLabel(null)).toBeNull();
  });

  it("renders a 12-hour clock", () => {
    expect(hourClockLabel(16)).toBe("4pm");
    expect(hourClockLabel(11)).toBe("11am");
    expect(hourClockLabel(0)).toBe("12am");
    expect(hourClockLabel(12)).toBe("12pm");
  });
});

describe("lightExposureLine — states a window, never a deadline", () => {
  it("renders the issue's shape on a clear day", () => {
    expect(lightExposureLine({ ...favorable, windowEndHour: 16 })).toBe(
      "Sunny, UV moderate until 4pm — good window for light exposure."
    );
  });

  it("says 'Partly sunny' when the sky is partly cloudy", () => {
    expect(
      lightExposureLine({
        ...favorable,
        weatherCode: PARTLY,
        windowEndHour: 15,
      })
    ).toBe(
      "Partly sunny, UV moderate until 3pm — good window for light exposure."
    );
  });

  it("omits the 'until' clause rather than inventing a time", () => {
    expect(lightExposureLine({ ...favorable, windowEndHour: null })).toBe(
      "Sunny, UV moderate — good window for light exposure."
    );
  });

  it("composes the tracked practice's pace when it is behind", () => {
    expect(
      lightExposureLine({
        ...favorable,
        windowEndHour: 16,
        pacePhrase: "Morning light exposure is 2/5 this week",
      })
    ).toBe(
      "Sunny, UV moderate until 4pm — good window for light exposure — Morning light exposure is 2/5 this week."
    );
  });

  it("carries no imperative verb and no deadline word", () => {
    const line = lightExposureLine({ ...favorable, windowEndHour: 16 })!;
    expect(line).not.toMatch(
      /\b(get outside|go outside|make sure|you should|by \d)/i
    );
  });

  it("an unfavorable day renders nothing at all", () => {
    expect(
      lightExposureLine({
        ...favorable,
        weatherCode: RAIN,
        windowEndHour: 16,
      })
    ).toBeNull();
    expect(
      lightExposureLine({
        ...favorable,
        weatherCode: null,
        uvIndexMax: null,
        windowEndHour: null,
      })
    ).toBeNull();
  });
});
