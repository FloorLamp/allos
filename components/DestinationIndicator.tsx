import { IconChevronRight } from "@tabler/icons-react";

// The one approved rightward destination cue. Link presentations place this
// where their layout needs it; callers cannot vary the glyph or its geometry.
export default function DestinationIndicator() {
  return (
    <IconChevronRight aria-hidden className="h-4 w-4 shrink-0" stroke={1.75} />
  );
}
