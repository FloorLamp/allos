// Profile avatar: the stored photo when one is set (served through the
// authorized /profile-photo route with a ?v= cache-buster), otherwise an
// initials fallback on a deterministic per-profile color. Pure markup — no hooks
// or server-only APIs — so it renders inside both Server and Client components.

export interface AvatarProfile {
  id: number;
  name: string;
  photo_path: string | null;
  photo_version: number;
}

// A small palette of (light, dark) background/text pairs. The profile id picks
// one deterministically, so the same person always gets the same color.
const PALETTE = [
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
];

const SIZES = {
  sm: "h-7 w-7 text-[0.65rem]",
  md: "h-12 w-12 text-base",
} as const;

// First letters of up to the first two words (e.g. "Jane Doe" → "JD",
// "Jane" → "J"), uppercased. Falls back to "?" for an empty name.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.slice(0, 2).map((p) => p[0]);
  return letters.join("").toUpperCase();
}

export default function Avatar({
  profile,
  size = "sm",
  className = "",
}: {
  profile: AvatarProfile;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const base = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${SIZES[size]} ${className}`;

  if (profile.photo_path) {
    // An authorized, per-session dynamic route — not a static asset — so
    // next/image (which can't carry the session cookie's auth) doesn't apply.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/profile-photo/${profile.id}?v=${profile.photo_version}`}
        alt={profile.name}
        className={`${base} object-cover`}
      />
    );
  }

  const color = PALETTE[profile.id % PALETTE.length];
  return (
    <span
      aria-hidden="true"
      className={`${base} ${color} font-semibold leading-none`}
    >
      {initials(profile.name)}
    </span>
  );
}
