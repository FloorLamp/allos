// Resolve release-owned paths against deployment-owned origins before mounting a shell bar.
export function resolveNav(nav, origins) {
  return nav.map(({origin, href, ...entry}) => {
    const base = new URL(origins?.[origin]);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password ||
        base.pathname !== '/' || base.search || base.hash) throw new Error(`Invalid entry origin: ${origin}`);
    if (!href.startsWith('/') || href.startsWith('//')) throw new Error(`Invalid entry path: ${entry.id}`);
    const url = new URL(href, base);
    if (url.origin !== base.origin) throw new Error(`Invalid entry path: ${entry.id}`);
    return {...entry, href: url.href};
  });
}
