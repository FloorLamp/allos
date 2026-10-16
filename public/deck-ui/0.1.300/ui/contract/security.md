# Security

## Security (first slice of #389)

`mountSecurity(element, sources)` provides a reusable read-only inventory. Each supplied source
is an HTTP adapter protected by explicit owner-device admin permission. Source schemas, ownership,
unavailable states and the boarding identity endpoint are specified in [SECURITY.md](../SECURITY.md).
The mount does not install a hosted route, fetch public board data, or offer mutation actions.

