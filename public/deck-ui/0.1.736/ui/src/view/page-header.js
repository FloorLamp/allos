import {h} from '../../vendor/preact.mjs';

/** The page title, a short description, actions and optional navigation. */
export function PageHeader({title, description, actions, tabs, inlineTabs = false}) {
  return h('header', {class: 'dk-page-header'},
    h('div', {class: 'dk-page-heading'},
      h('div', {class: 'dk-page-titles'}, inlineTabs ? h('div', {class: 'dk-page-title-row'}, h('h1', {}, title), tabs) : h('h1', {}, title), description ? h('p', {}, description) : null),
      actions ? h('div', {class: 'dk-page-actions'}, actions) : null),
    tabs && !inlineTabs ? h('div', {class: 'dk-page-tabs'}, tabs) : null);
}
