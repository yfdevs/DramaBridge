import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type PageSizeOption = { value: string; label: string };
type PageSizeProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PageSizeOption[];
  className?: string;
};

export function YoutubePageSizeSelect({
  label,
  value,
  onChange,
  options,
  className,
}: PageSizeProps) {
  const visibleOptions = options.filter((option) => option.label.trim());
  const selected = visibleOptions.find((option) => option.value === value);
  return (
    <div className="flex min-w-0 items-center gap-2">
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
