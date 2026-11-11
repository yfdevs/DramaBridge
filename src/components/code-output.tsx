import { useState } from "react";
import { WrapTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";

export function CodeOutput({
  title,
  value,
  className,
}: {
  title: string;
  value: string;
  className?: string;
}) {
  const [wrap, setWrap] = useState(true);
  return (
    <CodeBlock size="sm" className={className}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="自动换行"
            title="自动换行"
            aria-pressed={wrap}
            onClick={() => setWrap((current) => !current)}
          >
            <WrapTextIcon aria-hidden="true" />
          </Button>
          <CodeBlockCopyButton value={value} aria-label={`复制${title}`} title={`复制${title}`} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} className="max-h-96" aria-label={title}>
        {value}
      </CodeBlockContent>
    </CodeBlock>
  );
}
