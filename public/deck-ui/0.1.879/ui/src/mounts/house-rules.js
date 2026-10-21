import {h, render} from '../../vendor/preact.mjs';
import {createRules} from '../house-rules.js';
import {HouseRules} from '../view/house-rules.js';
import {pageNavigation} from '../page-navigation.js';
import {drawing} from '../mount-runtime.js';

/** The Rules page (contract/house.md *Rules*) on a host whose registry has a habitat backend. opts: `member` (Habitat's `/api/member`
 *  shape: the owner, not read-only, gets the switch), `clock`. Answers {rules, ready, unmount()}. */
export function mountHouseRules(el, host, opts = {}) {
  const rules = createRules(host, {owner: !!opts.member?.owner && !opts.member.read_only, clock: opts.clock});
  const navigation = pageNavigation(el.ownerDocument, null);
  const d = drawing(el, 'HouseRules', () => render(h(HouseRules, {rules, navigation}), el));
  const off = rules.subscribe(() => d.draw());
  navigation.start();
  return {rules, ready: rules.start(), unmount() { off(); d.unmount(); }};
}
