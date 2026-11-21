import type { ReactNode } from "react";
import { cn } from "cn";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

function StackedCardsIllustration() {
  return (
    <div className="relative h-24 w-52 max-w-full" aria-hidden="true">
      <div className="bg-muted/60 dark:bg-muted/30 border-border/50 absolute inset-x-6 top-0 h-6 rounded-t-lg border" />
      <div className="bg-muted/80 dark:bg-muted/50 border-border/60 absolute inset-x-3 top-3 h-6 rounded-t-lg border" />
      <div className="bg-background border-border absolute inset-x-0 top-6 flex h-16 items-center gap-2 rounded-lg border px-3 shadow-sm">
        <div className="bg-muted size-8 shrink-0 rounded" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="bg-muted h-2.5 w-3/4 rounded" />
          <div className="bg-muted/60 h-2 w-1/2 rounded" />
        </div>
      </div>
      <div className="from-background/0 via-background/60 to-background pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b" />
    </div>
  )
}

export function EmptyStateCard({ title, description, action, className }: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("gap-3 border-none px-4 py-6 whitespace-normal", className)}>
      <EmptyHeader role="status" className="w-full gap-1">
        <EmptyMedia className="mb-1 w-full">
          <StackedCardsIllustration />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription className="text-xs leading-5">{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
