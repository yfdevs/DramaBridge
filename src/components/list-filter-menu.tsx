import { SlidersHorizontal, RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { OverflowText } from "@/components/ui/overflow-text";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type ListFilterGroup = {
  key: string;
  label: string;
  value: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
};

export function ListFilterMenu({ label = "筛选", groups, icon, showLabel = true }: {
  label?: string;
  groups: ListFilterGroup[];
  icon?: ReactNode;
  showLabel?: boolean;
}) {
  const mobile = useIsMobile();
  const activeCount = groups.filter(group => group.value !== group.defaultValue).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button type="button" size={showLabel ? "sm" : "icon-sm"}
          variant={activeCount ? "secondary" : "outline"}
          title={label} aria-label={label} className="h-7 gap-1.5 text-xs">
          {icon ?? <SlidersHorizontal aria-hidden="true" />}
          {showLabel && "筛选"}
          {activeCount > 0 && <span className="rounded bg-foreground/10 px-1 text-xs leading-4 tabular-nums">{activeCount}</span>}
        </Button>
      } />
      <DropdownMenuContent align="start" sideOffset={6} className="w-56 max-w-[calc(100vw-2rem)] p-1">
        {groups.map(group => {
          const selected = group.options.find(option => option.value === group.value);
          const active = group.value !== group.defaultValue;
          return <DropdownMenuSub key={group.key}>
            <DropdownMenuSubTrigger className="min-h-8 gap-2 px-2 text-xs">
              <span className={`size-1.5 shrink-0 rounded-full ${active ? "bg-primary" : "bg-transparent"}`} />
              <span className="shrink-0">{group.label}</span>
              <OverflowText className={`ml-auto min-w-0 flex-1 text-right text-xs ${active ? "text-foreground" : "text-muted-foreground"}`}>{selected?.label}</OverflowText>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent side={mobile ? "bottom" : "right"} sideOffset={4} alignOffset={-4}
              className="max-h-[min(24rem,60vh)] w-max min-w-40 max-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto p-1">
              <DropdownMenuRadioGroup value={group.value} onValueChange={value => {if (typeof value === "string") group.onChange(value);}}>
                {group.options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value}
                  closeOnClick={false} className="min-h-8 pl-2 text-xs data-checked:bg-secondary data-checked:font-medium">
                  <OverflowText className="min-w-0 flex-1">{option.label}</OverflowText>
                </DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>;
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!activeCount} closeOnClick={false} className="min-h-8 px-2 text-xs text-muted-foreground"
          onClick={() => groups.forEach(group => group.onChange(group.defaultValue))}>
          <RotateCcwIcon className="size-3.5" /> 重置筛选
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
