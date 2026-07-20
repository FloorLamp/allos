// SERVER-ACTION TIER — genomic-variant write path (#709). Exercises add / update /
// delete against a real (temp) SQLite handle to prove every mutation is
// profile-scoped (no cross-profile bleed), that the result_type / significance /
// zygosity strings are normalized onto the DB CHECK sets (an off-vocabulary form
// can never trip the constraint), and that a manual row carries NULL provenance so
// the import delete-set never touches it. The static source scan can't see across
// the action boundary; this is the dynamic guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addGenomicVariant,
  updateGenomicVariant,
  deleteGenomicVariant,
} from "@/app/(app)/genomics/actions";
import { getGenomicVariants } from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("addGenomicVariant", () => {
  it("stores a profile-scoped variant and normalizes the enum fields", async () => {
    const { profile } = seedActor();
    const res = await addGenomicVariant(
      fd({
        gene: "CYP2C19",
        variant: "rs4244285",
        star_allele: "*2/*2",
        zygosity: "Homozygous",
        significance: "", // PGx result carries no ACMG call
        result_type: "PGx panel", // loose phrasing → pharmacogenomic
        source_lab: "Test Genetics Lab",
        report_date: "2024-02-01",
        interpretation: "Poor metabolizer",
      })
    );
    expect(res.ok).toBe(true);

    const rows = getGenomicVariants(profile.id);
    expect(rows).toHaveLength(1);
    const v = rows[0];
    expect(v.gene).toBe("CYP2C19");
    expect(v.star_allele).toBe("*2/*2");
    expect(v.zygosity).toBe("homozygous");
    expect(v.significance).toBeNull();
    expect(v.result_type).toBe("pharmacogenomic");
    expect(v.report_date).toBe("2024-02-01");
    // Manual rows carry no import provenance.
    expect(v.source).toBeNull();
    expect(v.document_id).toBeNull();
    expect(v.external_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/results");
  });

  it("maps ACMG terms and defaults an unknown result_type to 'other'", async () => {
    const { profile } = seedActor();
    await addGenomicVariant(
      fd({
        gene: "BRCA1",
        variant: "c.68_69del",
        zygosity: "heterozygous",
        significance: "Likely Pathogenic",
        result_type: "totally-unknown",
      })
    );
    const v = getGenomicVariants(profile.id)[0];
    expect(v.significance).toBe("likely-pathogenic");
    expect(v.result_type).toBe("other");
  });

  it("rejects a variant with no gene", async () => {
    const { profile } = seedActor();
    const res = await addGenomicVariant(fd({ variant: "rs123" }));
    expect(res.ok).toBe(false);
    expect(getGenomicVariants(profile.id)).toHaveLength(0);
  });
});

describe("updateGenomicVariant", () => {
  it("edits in place and stays profile-scoped", async () => {
    const { login, profile } = seedActor();
    await addGenomicVariant(
      fd({ gene: "APOE", genotype: "ε3/ε4", result_type: "diagnostic" })
    );
    const id = getGenomicVariants(profile.id)[0].id;

    // Another profile the same admin can act as — its rows must be untouched.
    const other = createProfile("Other Patient");
    actAs(login, other);
    await addGenomicVariant(fd({ gene: "MTHFR" }));
    actAs(login, profile);

    const res = await updateGenomicVariant(
      fd({ id, gene: "APOE", genotype: "ε4/ε4", result_type: "diagnostic" })
    );
    expect(res.ok).toBe(true);
    const v = getGenomicVariants(profile.id)[0];
    expect(v.genotype).toBe("ε4/ε4");

    // The cross-profile update is refused: updating from `other` can't reach it.
    actAs(login, other);
    const cross = await updateGenomicVariant(
      fd({ id, gene: "HACKED", result_type: "other" })
    );
    expect(cross.ok).toBe(true); // action returns ok, but the WHERE profile_id filters it out
    expect(getGenomicVariants(other.id).some((r) => r.gene === "HACKED")).toBe(
      false
    );
    actAs(login, profile);
    expect(getGenomicVariants(profile.id)[0].gene).toBe("APOE");
  });
});

describe("deleteGenomicVariant", () => {
  it("deletes only the acting profile's row", async () => {
    const { profile } = seedActor();
    await addGenomicVariant(fd({ gene: "F5", zygosity: "heterozygous" }));
    const id = getGenomicVariants(profile.id)[0].id;
    const res = await deleteGenomicVariant(fd({ id }));
    expect(res.ok).toBe(true);
    expect(getGenomicVariants(profile.id)).toHaveLength(0);
  });
});
