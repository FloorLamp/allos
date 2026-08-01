// ACTION TIER — "Allow re-acquisition" (#1777), the one user-facing tombstone-clearing
// surface in the app.
//
// Three things are worth pinning, and they are the file:
//
//   IT IS A WRITE, gated like one. Clearing a tombstone re-opens a profile to acquirer
//   pushes of those bytes, so a read-only caregiver must not be able to do it.
//
//   THE OUTCOME IS TYPED, because the tombstone may already be gone — a second tab
//   pressed the same button, or a human re-upload cleared it on the way in. Answering
//   "Allowed" regardless would confirm a write that did not happen.
//
//   IT ACTUALLY LIFTS THE BLOCK, rather than just hiding the row: after the tap, the
//   acquirer path stores the same bytes it was refusing a moment earlier.

import { describe, expect, it } from "vitest";
import { allowDocumentReacquisition } from "@/app/(app)/data/review-actions";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import {
  isDocumentTombstoned,
  listDocumentTombstones,
  writeDocumentTombstone,
} from "@/lib/document-tombstones";
import { actAs, createLogin, createProfile, fd, seedActor } from "./harness";

describe("allowDocumentReacquisition", () => {
  it("clears the tombstone and says so", async () => {
    const { profile } = seedActor();
    const hash = "e2e-doc-hash-allow-1";
    writeDocumentTombstone(profile.id, hash, "allowed-again.pdf");

    const res = await allowDocumentReacquisition(fd({ hash }));

    expect(res.status).toBe("done");
    expect(res.message).toContain("bring this document back");
    expect(isDocumentTombstoned(profile.id, hash)).toBe(false);
    expect(listDocumentTombstones(profile.id)).toHaveLength(0);
  });

  it("returns a typed already-allowed outcome rather than a false success", async () => {
    const { profile } = seedActor();
    const hash = "e2e-doc-hash-allow-2";
    writeDocumentTombstone(profile.id, hash, "twice.pdf");

    expect((await allowDocumentReacquisition(fd({ hash }))).status).toBe(
      "done"
    );
    const second = await allowDocumentReacquisition(fd({ hash }));

    // Not an error — the desired state already holds — but not "done" either, because
    // this press wrote nothing.
    expect(second.status).toBe("already-allowed");
    expect(second.message).toContain("already");
    expect(isDocumentTombstoned(profile.id, hash)).toBe(false);
  });

  it("refuses without write access", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`Readonly allow ${login.id}`, login.id);
    const hash = "e2e-doc-hash-allow-3";
    writeDocumentTombstone(profile.id, hash, "readonly.pdf");

    actAs(login, profile, "read");
    await expect(allowDocumentReacquisition(fd({ hash }))).rejects.toThrow();

    // The block still stands — a caregiver who may only look cannot re-open the
    // profile to acquirer pushes of bytes its owner deleted.
    expect(isDocumentTombstoned(profile.id, hash)).toBe(true);
  });

  it("refuses a missing hash without touching anything", async () => {
    const { profile } = seedActor();
    writeDocumentTombstone(profile.id, "e2e-doc-hash-allow-4", "kept.pdf");

    const res = await allowDocumentReacquisition(fd({ hash: "" }));

    expect(res.status).toBe("error");
    expect(listDocumentTombstones(profile.id)).toHaveLength(1);
  });

  it("never reaches another profile's tombstone", async () => {
    const a = seedActor();
    const b = seedActor();
    const hash = "e2e-doc-hash-allow-5";
    writeDocumentTombstone(a.profile.id, hash, "not-yours.pdf");

    // b is the acting profile; the clear is profile-scoped, so it finds nothing.
    actAs(
      { id: b.login.id, username: b.login.username, role: b.login.role },
      b.profile
    );
    const res = await allowDocumentReacquisition(fd({ hash }));

    expect(res.status).toBe("already-allowed");
    expect(isDocumentTombstoned(a.profile.id, hash)).toBe(true);
  });

  it("really lifts the block: the acquirer can push those bytes again", async () => {
    const { login, profile } = seedActor();
    const body = `%PDF-1.4\n% allos spec document allow-lifts\n%%EOF\n`;
    const file = () =>
      new File([Buffer.from(body)], "allow-lifts.pdf", {
        type: "application/pdf",
      });

    const first = await ingestMedicalUpload(login.id, profile.id, file(), {
      acquirer: true,
    });
    const hash = first.contentHash!;
    writeDocumentTombstone(profile.id, hash, "allow-lifts.pdf");

    // Blocked while the tombstone stands.
    const blocked = await ingestMedicalUpload(login.id, profile.id, file(), {
      acquirer: true,
    });
    expect(blocked.refusal).toBe("blocked");

    await allowDocumentReacquisition(fd({ hash }));

    // …and afterwards the acquirer gets the ordinary answer for bytes allos already
    // has, rather than the refusal. The block is gone, not merely hidden.
    const after = await ingestMedicalUpload(login.id, profile.id, file(), {
      acquirer: true,
    });
    expect(after.refusal).toBe("already-held");
  });
});
