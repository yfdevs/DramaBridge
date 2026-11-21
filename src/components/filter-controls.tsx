import type { ReactNode } from "react";
import { CloseIcon, SearchIcon } from "@/components/ui/solar-icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export function FilterToolbar({ children, label, className }: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div role="search" aria-label={label} className={cn("@container flex min-w-0 flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}

export function FilterSearchField({ label, placeholder, value, onChange, onSearch }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSearch?: () => void;
}) {
  return (
    <InputGroup className="h-7 w-full min-w-0 basis-full rounded-md @min-[480px]:max-w-80 @min-[480px]:flex-1 @min-[480px]:basis-auto">
      <InputGroupAddon>
        <SearchIcon className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSearch) {
            event.preventDefault();
            onSearch();
          }
        }}
        className="text-xs md:text-xs [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="清空搜索" size="icon-xs" onClick={() => onChange("")}>
            <CloseIcon className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
