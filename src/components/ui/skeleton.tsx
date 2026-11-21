import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-md bg-foreground/[0.07] motion-safe:animate-pulse dark:bg-foreground/10", className)}
      {...props}
    />
  )
}

export { Skeleton }
