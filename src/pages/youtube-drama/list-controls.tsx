import type { useYoutubePagination } from "./use-youtube-pagination";
import { YoutubeFilterSelect } from "./filter-controls";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";

export function YoutubeListPagination({
  list,
}: {
  list: Omit<ReturnType<typeof useYoutubePagination>, "items">;
}) {
  const pages = [...new Set([1, list.page - 1, list.page, list.page + 1, list.pageCount])]
    .filter((page) => page >= 1 && page <= list.pageCount)
    .sort((a, b) => a - b);
  const changePage = (event: React.MouseEvent, page: number) => {
    event.preventDefault();
    if (page >= 1 && page <= list.pageCount) list.setPage(page);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t py-3 text-xs">
      <p className="text-muted-foreground" aria-live="polite">
        共 {list.total} 条
        {list.total > 0 &&
          ` · 第 ${(list.page - 1) * list.pageSize + 1}–${Math.min(list.page * list.pageSize, list.total)} 条`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <YoutubeFilterSelect
          label="每页条数"
          value={String(list.pageSize)}
          onChange={(value) => list.setPageSize(Number(value))}
          className="min-w-0 w-28"
          options={[10, 20, 50].map((value) => ({
            value: String(value),
            label: `${value} 条 / 页`,
          }))}
        />
        <Pagination aria-label="列表分页" className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                text="上一页"
                aria-label="上一页"
                href="#"
                aria-disabled={list.page <= 1}
                tabIndex={list.page <= 1 ? -1 : 0}
                className={list.page <= 1 ? "pointer-events-none opacity-40" : ""}
                onClick={(event) => changePage(event, list.page - 1)}
              />
            </PaginationItem>
            {pages.map((page, index) => (
              <PaginationItem key={page} className="hidden items-center sm:flex">
                {index > 0 && page - pages[index - 1] > 1 && <PaginationEllipsis />}
                <PaginationLink
                  size="icon-sm"
                  href="#"
                  isActive={page === list.page}
                  aria-label={`第 ${page} 页`}
                  onClick={(event) => changePage(event, page)}
                >
                  {page}
                </PaginationLink>
              </PaginationItem>
            ))}
            <PaginationItem className="px-1 tabular-nums sm:hidden">
              {list.page} / {list.pageCount}
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                text="下一页"
                aria-label="下一页"
                href="#"
                aria-disabled={list.page >= list.pageCount}
                tabIndex={list.page >= list.pageCount ? -1 : 0}
                className={list.page >= list.pageCount ? "pointer-events-none opacity-40" : ""}
                onClick={(event) => changePage(event, list.page + 1)}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
