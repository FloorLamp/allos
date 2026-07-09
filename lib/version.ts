import { execSync } from "child_process";

// The GitHub repo the deployed image is built from — used to link a commit
// hash back to its source. Keep in sync with the deploy workflow's IMAGE.
const REPO_URL = "https://github.com/FloorLamp/allos";

export type AppVersion = {
  /** Short (7-char) commit hash, or null when it can't be determined. */
  sha: string | null;
  /** Commit subject/message, or null when it can't be determined. */
  commitMessage: string | null;
  /** Link to the commit on GitHub, or null when the sha is unknown. */
  commitUrl: string | null;
};

/**
 * Normalize a raw commit SHA (full, short, or padded with whitespace) to the
 * canonical 7-char short form. Returns null for anything that isn't a plausible
 * hex SHA — pure so it can be unit-tested without a git checkout.
 */
export function shortSha(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return null;
  return trimmed.slice(0, 7);
}

let cached: AppVersion | undefined;

/**
 * Resolve the running app's commit hash. Prefers a build-time env var (baked
 * into the Docker image, since `.git` is excluded from the build context), and
 * falls back to reading git directly — which works in local dev where the
 * checkout is present. Result is memoized for the process lifetime.
 */
export function getAppVersion(): AppVersion {
  if (cached) return cached;

  const sha = shortSha(process.env.COMMIT_SHA) ?? shortSha(gitHead());
  cached = {
    sha,
    commitMessage: process.env.COMMIT_MESSAGE?.trim() || gitMessage(),
    commitUrl: sha ? `${REPO_URL}/commit/${sha}` : null,
  };
  return cached;
}

function gitHead(): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function gitMessage(): string | null {
  try {
    return (
      execSync("git log -1 --pretty=%s", {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}
