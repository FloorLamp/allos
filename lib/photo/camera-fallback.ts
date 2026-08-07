// Pure decisions for PhotoCapture's native-picker fallback (#2182). User
// activation is a hard browser boundary: a known fallback may click the input
// synchronously only from a real tap; an auto-open deep link must show a dialog.

export type CameraKnowledge = "unknown" | "granted" | "denied" | "failed";
export type CameraStartDecision =
  "direct-picker" | "try-camera" | "show-fallback";

export function cameraStartDecision(input: {
  userInitiated: boolean;
  hasGetUserMedia: boolean;
  knowledge: CameraKnowledge;
}): CameraStartDecision {
  if (!input.userInitiated) return "show-fallback";
  if (!input.hasGetUserMedia) return "direct-picker";
  if (input.knowledge === "denied" || input.knowledge === "failed")
    return "direct-picker";
  return "try-camera";
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
