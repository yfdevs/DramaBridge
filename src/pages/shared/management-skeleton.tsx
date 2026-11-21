import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type SkeletonColumn = string | { placeholder: string; cell: string };

export function ManagementTableSkeleton({ columns, rows = 5, rowClassName }: {
  columns: readonly SkeletonColumn[];
  rows?: number;
  rowClassName?: string;
}) {
  return Array.from({ length: rows }, (_, row) => (
    <TableRow key={row} aria-hidden="true" className={rowClassName}>
      {columns.map((column, index) => (
        <TableCell key={index} className={typeof column === "string" ? undefined : column.cell}>
          <Skeleton className={cn(
            "h-2.5 max-w-full",
            typeof column === "string" ? column : column.placeholder,
            index === 0 && row % 2 === 1 && "opacity-75",
          )} />
        </TableCell>
      ))}
    </TableRow>
  ));
}

export function ManagementListSkeleton({ label, account = false, rows = 5 }: {
  label: string;
  account?: boolean;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className={cn(
      "min-w-0 divide-y divide-border/50",
      account && "rounded-lg border border-border/60 px-3",
    )}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} aria-hidden="true" className="flex items-center gap-3 py-2.5">
          {account && <Skeleton className="size-4 shrink-0 rounded-sm" />}
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn("h-2.5", row % 2 === 0 ? "w-2/5 max-w-40" : "w-1/3 max-w-32")} />
            <Skeleton className="h-2 w-1/4 max-w-24 opacity-75" />
          </div>
          <Skeleton className="h-4 w-12 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function ManagementStatusSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex h-4 items-center gap-4">
      <Skeleton className="h-2.5 w-20" aria-hidden="true" />
      <Skeleton className="h-2.5 w-28" aria-hidden="true" />
      <Skeleton className="hidden h-2.5 w-16 sm:block" aria-hidden="true" />
    </div>
  );
}
