/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Tree-shake barrel imports: only the icon/chart pieces actually used are
    // pulled into each route's bundle (Next rewrites `import { X } from "pkg"`
    // to deep per-module imports), shrinking the client JS on analytics routes.
    optimizePackageImports: ["recharts", "@tabler/icons-react"],
    // better-sqlite3 is a native module; keep it external to the server bundle.
    serverComponentsExternalPackages: ["better-sqlite3"],
    serverActions: {
      // Server Action body cap. Next 14 defaults this to 1MB, which would silently
      // reject the 1–32MB uploads `uploadMedicalDocument` explicitly permits before
      // the action runs. Set to 33MB (not 32MB) on purpose: the multipart body is
      // the file bytes PLUS boundary/field overhead, so a file at the action's 32MB
      // `MAX_BYTES` (app/(app)/medical/actions.ts) produces a body just over 32MB.
      // The 1MB of headroom keeps the action's own 32MB gate authoritative, so an
      // over-size file hits its friendly `insertFailedDoc` audit path instead of an
      // opaque framework rejection.
      bodySizeLimit: "33mb",
    },
  },
};

module.exports = nextConfig;
