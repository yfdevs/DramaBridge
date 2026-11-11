import { FunnelIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";

type ListFilterGroup = {
  key: string;
  label: string;
  value: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
};

export function ListFilterMenu({
  label = "筛选",
  groups,
}: {
  label?: string;
  groups: ListFilterGroup[];
}) {
  const mobile = useIsMobile();
  const activeCount = groups.filter((group) => group.value !== group.defaultValue).length;
  const accessibleLabel = activeCount ? `${label}，已选 ${activeCount} 项条件` : label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={activeCount ? "secondary" : "outline"}
            aria-label={accessibleLabel}
            title={accessibleLabel}
            className="relative"
          >
            <FunnelIcon aria-hidden="true" />
            {activeCount > 0 && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-xs leading-4 tabular-nums text-primary-foreground"
              >
                {activeCount}
              </span>
            )}
          </Button>
        }
      />
      <DropdownMenuContent
        aria-label={label}
        sideOffset={6}
        className="w-64 max-w-[calc(100vw-2rem)]"
      >
        {groups.map((group) => {
          const selected = group.options.find((option) => option.value === group.value);
          return (
            <DropdownMenuSub key={group.key}>
              <DropdownMenuSubTrigger className="min-h-7 gap-2 text-[0.8rem]">
                <span>{group.label}</span>
                <span
                  className="ml-auto max-w-28 truncate text-xs text-muted-foreground"
                  title={selected?.label}
                >
                  {selected?.label}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                aria-label={group.label}
                side={mobile ? "bottom" : "right"}
                alignOffset={mobile ? 0 : -3}
                sideOffset={4}
                className="min-w-44 max-w-[calc(100vw-2rem)]"
              >
                <DropdownMenuRadioGroup
                  value={group.value}
                  onValueChange={(value) => {
                    if (typeof value === "string") group.onChange(value);
                  }}
                >
                  {group.options.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      className="min-h-7 text-[0.8rem]"
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        <DropdownMenuItem
          disabled={!activeCount}
          closeOnClick={false}
          className="min-h-7 text-[0.8rem]"
          onClick={() => groups.forEach((group) => group.onChange(group.defaultValue))}
        >
          <RotateCcwIcon aria-hidden="true" />
          重置筛选
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
