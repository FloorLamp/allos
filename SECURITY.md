# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**. Do **not** open a public
GitHub issue for a security bug — public issues are visible to everyone and can
expose users before a fix is available.

To report a vulnerability, use GitHub's private advisory workflow:

1. Go to the repository's **Security** tab.
2. Select **Advisories → Report a vulnerability**.

This opens a private channel visible only to the maintainers. Please include:

- a description of the issue and its potential impact,
- steps to reproduce (a proof of concept if possible),
- affected routes, versions, or configuration, and
- any suggested remediation.

We will acknowledge your report, keep you updated on our progress, and credit
you (if you wish) once a fix is released.

## Supported versions

Allos is developed as a rolling release. Security fixes are applied to the
`main` branch, and self-hosters should track `main` (or the latest published
container image) to receive them. Older commits and tags are not separately
patched.

## Scope

Because Allos stores personal health information (PHI), we are especially
interested in reports involving authentication/session handling, profile data
isolation (cross-profile data access), file upload/serving, and any path that
could leak stored medical data. Please never include real PHI in a report — use
synthetic or redacted data to demonstrate an issue.

## Audit logging

Allos keeps a durable audit log (the `audit_events` table) recording **who did
what to whose data**, reviewable by an admin under **Settings → Audit**. Each
event stores a timestamp, the acting login (null for unauthenticated events such
as a failed login or a public share-link view), the active profile being acted
on, an action (e.g. `login.success`, `profile.switch`, `medical-file.view`,
`medical-document.upload`/`delete`, `share-link.create`/`revoke`/`view`,
`grant.update`, `login.create`/`delete`, `login.password-reset`), and short
coarse identifiers (record/file/login ids, a username, a grant diff).

What is recorded:

- **Authentication** — login success/failure/throttle (username only, **never**
  the password), logout, own-password change, and admin password resets.
- **PHI access** — medical-file downloads and public share-link views (by file
  or link **id**, never the file contents or the raw share token).
- **Admin/family changes** — profile create/delete, login create/delete, and
  grant-matrix changes.

The `detail` and `target` fields hold **identifiers only — never medical
content**. Records are retained **90 days** by default and pruned by the hourly
maintenance tick. The log spans every profile, so the viewer is **admin-only**;
login/profile ids are kept even after the referent is deleted (no foreign key),
so the trail survives account deletion.
