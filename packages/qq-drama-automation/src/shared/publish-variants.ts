import type { ClaimedQqDramaTask } from "./types.js";

export type QqDramaPublishVariant = {
  kind: "primary" | "secondary";
  title: string;
};

export function shouldOpenNewQqDramaVariantPage(variantIndex: number) {
  return variantIndex > 0;
}

export function createQqDramaPublishVariants(
  task: ClaimedQqDramaTask,
  acceptSecondVersion = true,
): QqDramaPublishVariant[] {
  const variants: QqDramaPublishVariant[] = [{
    kind: "primary",
    title: task.playlet.title,
  }];
  if (acceptSecondVersion && task.playlet.secondVersionEnabled) {
    variants.push({
      kind: "secondary",
      title: task.playlet.secondVersionTitle!,
    });
  }
  return variants;
}
