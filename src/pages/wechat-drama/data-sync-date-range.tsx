import { useState } from "react";
import { format, isValid, parseISO } from "date-fns";
import { zhCN } from "react-day-picker/locale";
import type { DateRange } from "react-day-picker";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Range = { startDate: string; endDate: string };

function readDate(value: string): Date | undefined {
  if (!value) return undefined;
  const date = parseISO(value);
  return isValid(date) ? date : undefined;
}

export function DataSyncDateRange({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: Range;
  disabled: boolean;
  onChange: (range: Range) => void;
}) {
  const [open, setOpen] = useState(false);
  const from = readDate(value.startDate);
  const to = readDate(value.endDate);
  const selected: DateRange | undefined = from ? { from, to } : undefined;
  const summary = from
    ? `${format(from, "yyyy-MM-dd")}${to ? ` 至 ${format(to, "yyyy-MM-dd")}` : " 至 …"}`
    : "选择日期范围";

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button id={id} size="sm" variant="outline" disabled={disabled} />}
        aria-label={`${label}日期范围`}
        className="max-w-full gap-2 text-xs font-normal tabular-nums"
      >
        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{summary}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-0 p-0" aria-label={`${label}日期选择`}>
        <Calendar
          mode="range"
          locale={zhCN}
          selected={selected}
          defaultMonth={from ?? new Date()}
          numberOfMonths={2}
          endMonth={new Date()}
          disabled={{ after: new Date() }}
          onSelect={(range) =>
            onChange({
              startDate: range?.from ? format(range.from, "yyyy-MM-dd") : "",
              endDate: range?.to ? format(range.to, "yyyy-MM-dd") : "",
            })
          }
        />
        <div className="flex items-center justify-between gap-4 border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {from && to ? summary : "选择开始和结束日期"}
          </span>
          <Button size="sm" disabled={!from || !to} onClick={() => setOpen(false)}>
            确定
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
