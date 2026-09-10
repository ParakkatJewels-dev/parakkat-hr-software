import Pagination, { usePagination } from './Pagination';

// Small independently paged lists (kanban columns, pickers, history panels).
export default function PagedCollection({ items, children, noun = 'rows', pageSize = 10, resetKey = '', disabled = false }) {
  const pager = usePagination(items, pageSize, null, resetKey);
  return <div className="paged-collection">
    {children(pager.slice)}
    <Pagination {...pager} noun={noun} sizes={[pageSize, 25, 50]} disabled={disabled} />
  </div>;
}
