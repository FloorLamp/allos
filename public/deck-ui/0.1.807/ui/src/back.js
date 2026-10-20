// Back is a request, acknowledged only after the page consumes one navigation layer.
export function bindBack(host, back, doc = globalThis.document) {
  return host.on('back', ({id}) => {
    const menu = doc.querySelector('.ds-sheet-open .ds-nav-toggle, .ds-menu.open .ds-toggle');
    const drawer = [...doc.querySelectorAll('.dk-drawer')].filter(el => !el.closest('[hidden]')).at(-1);
    const cancel = doc.querySelector('.dh-confirm button:last-child');
    const close = cancel ?? menu ?? drawer?.querySelector('button[aria-label="Close"]');
    let handled;
    if (close) { close.click(); handled = true; }
    else handled = back();
    host.note('android.back', {id, handled});
  });
}
