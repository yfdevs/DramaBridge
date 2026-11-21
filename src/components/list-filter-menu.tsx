import { FilterIcon, UndoIcon as RotateCcwIcon } from "@/components/ui/solar-icons";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  options: { value: string; label: string; count?: number }[];
  onChange: (value: string) => void;
};

export function ListFilterMenu({ label = "筛选", groups }: {
  label?: string;
  groups: ListFilterGroup[];
}) {
  const mobile = useIsMobile();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const activeCount = groups.filter(group => group.value !== group.defaultValue).length;
  const renderOptions = (group: ListFilterGroup) => (
    <DropdownMenuRadioGroup
      aria-label={group.label}
      value={group.value}
      onValueChange={(value) => { if (typeof value === "string") group.onChange(value); }}
    >
      {group.options.map(option => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          closeOnClick={false}
          onClick={() => setOpenGroup(null)}
          className="min-h-8 pl-2 text-xs data-checked:bg-primary/10 data-checked:font-medium data-checked:text-primary"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
          {option.count !== undefined && (
            <span className="shrink-0 tabular-nums text-muted-foreground">{option.count}</span>
          )}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button type="button" size="sm"
          variant="state" data-active={activeCount ? "" : undefined}
          title={label} aria-label={label}
          aria-description={activeCount ? `已调整 ${activeCount} 项` : undefined}
          className="h-7 gap-1.5 text-xs">
          <span className="relative inline-flex shrink-0 items-center justify-center">
            <FilterIcon className="size-3.5" />
            {activeCount > 0 && (
              <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary ring-1 ring-background" />
            )}
          </span>
          筛选
        </Button>
      } />
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-48 min-w-0 max-w-[min(var(--available-width),calc(100vw-1rem))] p-1.5"
      >
        <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs">
          <span className="font-medium">{groups.length === 1 ? groups[0].label : "筛选选项"}</span>
          <span className="text-muted-foreground">{activeCount ? `已调整 ${activeCount} 项` : "默认"}</span>
        </div>
        <DropdownMenuSeparator className="mx-0" />
        {groups.length === 1 ? renderOptions(groups[0]) : groups.map(group => {
          const selected = group.options.find(option => option.value === group.value);
          const active = group.value !== group.defaultValue;
          return <DropdownMenuSub
            key={group.key}
            open={openGroup === group.key}
            onOpenChange={(open) => setOpenGroup(current => open ? group.key : current === group.key ? null : current)}
          >
            <DropdownMenuSubTrigger className="min-h-8 gap-2 px-2 text-xs">
              <span className={active ? "shrink-0 font-medium text-foreground" : "shrink-0"}>{group.label}</span>
              <span
                title={selected?.label}
                className={`min-w-0 flex-1 truncate text-right ${active ? "font-medium text-primary" : "text-muted-foreground"}`}
              >
                {selected?.label}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent side={mobile ? "bottom" : "right"} sideOffset={4} alignOffset={-4}
              className="max-h-[min(var(--available-height),24rem,60vh)] w-36 min-w-0 max-w-[min(var(--available-width),calc(100vw-1rem))] p-1.5">
              {renderOptions(group)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>;
        })}
        <DropdownMenuSeparator className="mx-0" />
        <DropdownMenuItem disabled={!activeCount} closeOnClick={false} className="min-h-8 gap-2 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setOpenGroup(null);
            groups.filter(group => group.value !== group.defaultValue).forEach(group => group.onChange(group.defaultValue));
          }}>
          <RotateCcwIcon className="size-3.5" /> 恢复默认
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
