import * as React from "react"
import { cn } from "cn"
import { OverflowText } from "./overflow-text"

function Table({ className, containerClassName, stickyActions = false, ...props }: React.ComponentProps<"table"> & { containerClassName?: string; stickyActions?: boolean }) {
  return (
    <div
      data-slot="table-container"
      className={cn("@container relative w-full min-w-0 max-w-full overflow-x-auto bg-background", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-xs leading-4 [&_[data-slot=button]]:h-6 [&_[data-slot=button]]:text-xs [&_[data-slot=button]]:gap-1 [&_[data-slot=button]_svg]:size-3.5", stickyActions && "table-sticky-actions", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b motion-safe:transition-colors",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-8 px-2 py-1 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, children, title, ...props }: React.ComponentProps<"td">) {
  const truncatedText = (className?.includes("truncate") || title) && (typeof children === "string" || typeof children === "number")
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2 py-1.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
      title={truncatedText ? undefined : title}
    >
      {truncatedText ? <OverflowText title={title}>{children}</OverflowText> : children}
    </td>
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-2 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
