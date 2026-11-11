import { Search, X } from "@mynaui/icons-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type FilterOption = { value: string; label: string };
type FilterProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  className?: string;
  caption?: string;
};

export function YoutubeFilterSelect({
  label,
  value,
  onChange,
  options,
  className,
  caption,
}: FilterProps) {
  const visibleOptions = options.filter((option) => option.label.trim());
  const selected = visibleOptions.find((option) => option.value === value);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
      <Select
        value={selected ? value : null}
        items={visibleOptions}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={label}
          title={label}
          className={cn("min-w-32", className)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="youtube-theme motion-reduce:animate-none">
          <SelectGroup>
            {visibleOptions.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                aria-label={option.label || `清除${label}筛选`}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

export function YoutubeSearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup className="h-7 w-full min-w-0 basis-full rounded-md sm:w-auto sm:min-w-48 sm:flex-1 sm:basis-auto sm:max-w-80">
      <InputGroupAddon>
        <Search aria-hidden="true" className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="text-xs"
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label={`清空${label}`} size="icon-xs" onClick={() => onChange("")}>
            <X className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
