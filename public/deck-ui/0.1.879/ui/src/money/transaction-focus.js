// Purser f334243 keyboard behavior, with mount-owned cleanup for observer and listener.
const ROW = '.dp-row[data-id]';
export function focusTransactionRow(root, id) {
  [...root.querySelectorAll(ROW)].find(row => row.dataset.id === String(id))?.focus();
}
export function prepareTransactionRows(root) {
  for (const row of root.querySelectorAll(ROW)) row.tabIndex = 0;
}
export function transactionRowKeys(root, open) {
  const observer = new root.ownerDocument.defaultView.MutationObserver(() => prepareTransactionRows(root));
  observer.observe(root, {childList: true, subtree: true});
  prepareTransactionRows(root);
  const key = event => {
    const row = event.target.closest(ROW);
    if (event.target !== row || event.repeat || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); open({id: row.dataset.id});
  };
  root.addEventListener('keydown', key);
  return () => { observer.disconnect(); root.removeEventListener('keydown', key); };
}
