import { managementContentClass } from "@/pages/shared/management-layout";
type PageShellProps = {
  title: string
  description?: string
}

export function PageShell({ title, description }: PageShellProps) {
  return (
    <main className={`${managementContentClass} min-h-full`}>
      <div className="space-y-1">
        <h1 className="text-sm font-medium">{title}</h1>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </main>
  )
}
