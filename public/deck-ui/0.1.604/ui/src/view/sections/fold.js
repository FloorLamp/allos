// The same preference shared by landing layouts and the native glance model.
import {useEffect, useState} from '../../../vendor/hooks.mjs';
import {COLLAPSED} from '../../glance.js';
export function useFold(host) {
  const [collapsed, setCollapsed] = useState(new Set());
  useEffect(() => {
    let live = true;
    host?.call('prefs.get', {key: COLLAPSED}).then(r => {
      if (live) setCollapsed(new Set((r?.value ?? '').split(',').filter(Boolean)));
    }).catch(() => {});
    return () => { live = false; };
  }, [host]);
  return {collapsed, toggle(id) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsed(next);
    host?.call('prefs.set', {key: COLLAPSED, value: [...next].join(',')}).catch(() => {});
  }};
}
