/** One bounded range for collection pages, palette rows and keyboard candidates. */
export function pageRange(total, page = 0, size = 40) {
  const pages = Math.max(1, Math.ceil(total / size));
  page = Math.min(pages - 1, Math.max(0, Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 0));
  const start = page * size, end = Math.min(total, start + size);
  return {size, total, pages, page, start, end};
}
