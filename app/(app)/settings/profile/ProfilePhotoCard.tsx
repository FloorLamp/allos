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
}: {
  profile: AvatarProfile;
}) {
  const router = useRouter();

  return (
    <div className="card mb-6 max-w-lg space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Photo
      </h2>
      <div className="flex items-center gap-4">
        <Avatar profile={profile} size="md" />
        <PhotoPicker
          hasPhoto={!!profile.photo_path}
          onUpload={(file) => {
            const fd = new FormData();
            fd.set("file", file);
            return uploadProfilePhoto(fd);
          }}
          onRemove={() => removeProfilePhoto(new FormData())}
          onDone={() => router.refresh()}
        />
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500">
        PNG, JPEG, or WebP, up to 5 MB. Shown as your avatar in the profile
        switcher.
      </p>
    </div>
  );
}
