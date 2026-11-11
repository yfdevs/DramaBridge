import { useEffect, useState } from "react";

export function useYoutubePagination<T>(items: T[]) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  useEffect(() => setPage((value) => Math.min(value, pageCount)), [pageCount]);
  return {
    page: currentPage,
    pageSize,
    pageCount,
    total: items.length,
    items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    setPage,
    reset: () => setPage(1),
    setPageSize: (value: number) => {
      setPageSize(value);
      setPage(1);
    },
  };
}
