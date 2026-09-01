// Pure decisions for the shared media form's camera option (#2182, #3286).

export type CameraKnowledge =
  "unreadable" | "unknown" | "granted" | "denied" | "failed";

/**
 * WHICH STAGE THE ADD-MEDIA DIALOG OPENS ON (#3286).
 *
 * The dialog is device-aware in its ORDERING, never in its capability: both
 * stages reach both paths. What moves is which one you land on.
 *
 * `camera` only where the camera is a live, plausible primary — a phone-width
 * viewport, or a camera this session already knows is granted. Everywhere else
 * the file picker leads, which is the whole defect: a desktop that never
 * granted camera used to open onto camera-recovery instructions with a green
 * "Open camera" as the only primary, and the file path demoted to a sentence.
 *
 * A camera KNOWN to be denied or broken never leads, on any viewport. Neither
 * does one whose permission state cannot be read: the camera remains one tap
 * away without making an unknowable first attempt the opening experience.
 */
export function mediaStartStage(input: {
  hasGetUserMedia: boolean;
  knowledge: CameraKnowledge;
  compactViewport: boolean;
}): "chooser" | "camera" {
  if (!input.hasGetUserMedia) return "chooser";
  if (
    input.knowledge === "unreadable" ||
    input.knowledge === "denied" ||
    input.knowledge === "failed"
  )
    return "chooser";
  if (input.knowledge === "granted") return "camera";
  return input.compactViewport ? "camera" : "chooser";
}

export type CameraDialogVariant =
  "blocked" | "not-found" | "in-use" | "unknown";

export function cameraDialogVariant(
  errorName: string | null | undefined,
  permissionState: PermissionState | null = null
): CameraDialogVariant {
  if (permissionState === "denied" || errorName === "NotAllowedError")
    return "blocked";
  if (errorName === "NotFoundError") return "not-found";
  if (errorName === "NotReadableError") return "in-use";
  return "unknown";
}

export type CameraRecoveryPlatform =
  "android-pwa" | "android-chrome" | "ios" | "desktop" | "generic";

export function cameraRecoveryPlatform(input: {
  userAgent: string;
  standalone: boolean;
}): CameraRecoveryPlatform {
  const ua = input.userAgent.toLowerCase();
  if (ua.includes("android"))
    return input.standalone ? "android-pwa" : "android-chrome";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/windows|macintosh|linux|cros/.test(ua)) return "desktop";
  return "generic";
}

export const CAMERA_RECOVERY_INSTRUCTIONS: Record<
  CameraRecoveryPlatform,
  readonly string[]
> = {
  "android-pwa": [
    "Open Android Settings, then Apps, this app, Permissions, Camera, and choose Allow.",
  ],
  "android-chrome": [
    "In Chrome, open the menu, then Settings, Site settings, Camera, and allow this site.",
  ],
  ios: [
    "Open Settings, Apps, Safari, Camera, or use Safari's page menu to allow Camera for this site.",
  ],
  desktop: [
    "Use the padlock or site-info control in the address bar to allow Camera for this site.",
  ],
  generic: ["In your browser's site settings, allow Camera for this site."],
};
