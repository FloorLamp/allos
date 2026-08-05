export function rideElapsedSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":").map(Number);
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return null;
  }
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

export function nearestRideElapsedIndex(
  values: readonly unknown[],
  activeLabel: unknown
): number {
  const target = rideElapsedSeconds(activeLabel);
  if (target == null) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < values.length; index++) {
    const seconds = rideElapsedSeconds(values[index]);
    if (seconds == null) continue;
    const distance = Math.abs(seconds - target);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}
