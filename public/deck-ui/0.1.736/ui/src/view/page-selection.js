import {useLayoutEffect, useState} from '../../vendor/hooks.mjs';

/** The collection mount supplies URL state; embedded palette collections keep their selection local. */
export function usePageSelection(navigation) {
  const [selected, setSelected] = useState(() => navigation?.hash || null);
  useLayoutEffect(() => navigation?.subscribe(() => setSelected(navigation.hash || null)), [navigation]);
  return [navigation ? navigation.hash || null : selected, id => {
    if (navigation) navigation.selectHash(id == null ? '' : String(id));
    else setSelected(id);
  }];
}
