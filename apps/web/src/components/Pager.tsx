/**
 * Newer / older buttons for a list shown a page at a time, with where you are
 * ("6–10 of 23"). Renders nothing when everything fits on one page.
 */
export function Pager({
  page,
  size,
  total,
  onPage,
  label,
  prev = "‹ Newer",
  next = "Older ›",
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  label: string;
  prev?: string;
  next?: string;
}) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return null;
  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" className="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {prev}
      </button>
      <span className="muted">
        {from}–{to} of {total}
      </span>
      <button type="button" className="secondary" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        {next}
      </button>
    </nav>
  );
}

/** The slice of `list` on page `page` of `size`, with the page kept in range. */
export function pageOf<T>(list: T[], page: number, size: number): { items: T[]; page: number } {
  const last = Math.max(0, Math.ceil(list.length / size) - 1);
  const p = Math.min(Math.max(0, page), last);
  return { items: list.slice(p * size, (p + 1) * size), page: p };
}
