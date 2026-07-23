"use client";

import { useRouter } from "next/navigation";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import PhotoPicker from "@/components/PhotoPicker";
import { uploadProfilePhoto, removeProfilePhoto } from "../photo-actions";

// Avatar management for the ACTIVE profile (Settings → Profile). No profileId is
// submitted, so the actions default to the caller's active profile. Admins manage
// other people's photos from the Family screen instead.
export default function ProfilePhotoCard({
  profile,
  // Demo mode (#181): disable the picker for the read-only demo member. The
  // upload action is already blocked server-side; this is the UX on top of it.
  disabled = false,
}: {
  profile: AvatarProfile;
  disabled?: boolean;
}) {
  const router = useRouter();

  return (
    <div className="card mb-6 max-w-lg space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Photo
      </h2>
      <div className="flex min-w-0 items-center gap-4">
        <Avatar profile={profile} size="md" />
        <PhotoPicker
          hasPhoto={!!profile.photo_path}
          disabled={disabled}
          onUpload={(file) => {
            const fd = new FormData();
            fd.set("file", file);
            return uploadProfilePhoto(fd);
          }}
          onRemove={() => removeProfilePhoto(new FormData())}
          onDone={() => router.refresh()}
        />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {disabled
          ? "Photo changes are disabled in demo."
          : "PNG, JPEG, or WebP, up to 5 MB. Shown as your avatar in the profile switcher."}
      </p>
    </div>
  );
}
