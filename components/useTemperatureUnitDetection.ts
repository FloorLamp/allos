"use client";

import { useRef, useState } from "react";
import type { TemperatureUnit } from "@/lib/settings";
import { detectTemperatureUnit } from "@/lib/vitals-input";

// Shared interaction for every manual temperature entry. Detection follows the
// reading until the user explicitly chooses a unit; clearing/resetting the field
// restores automatic mode and the login's preferred unit.
export function useTemperatureUnitDetection(
  preferredUnit: TemperatureUnit,
  initialValue = ""
) {
  const initialDetected = detectTemperatureUnit(Number(initialValue));
  const [unit, setUnit] = useState<TemperatureUnit>(
    initialValue.trim() && initialDetected ? initialDetected : preferredUnit
  );
  const [detectedUnit, setDetectedUnit] = useState<TemperatureUnit | null>(
    initialDetected
  );
  const manualOverride = useRef(false);

  function readValue(value: string) {
    if (!value.trim()) {
      manualOverride.current = false;
      setUnit(preferredUnit);
      setDetectedUnit(null);
      return;
    }
    if (manualOverride.current) return;
    const detected = detectTemperatureUnit(Number(value));
    setDetectedUnit(detected);
    if (detected) setUnit(detected);
  }

  function chooseUnit(next: TemperatureUnit) {
    manualOverride.current = true;
    setDetectedUnit(null);
    setUnit(next);
  }

  function reset() {
    manualOverride.current = false;
    setUnit(preferredUnit);
    setDetectedUnit(null);
  }

  return { unit, detectedUnit, readValue, chooseUnit, reset };
}
