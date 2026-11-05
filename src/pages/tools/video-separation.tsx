import { Scissors } from "@mynaui/icons-react";

export function VideoSeparationPage() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Scissors className="size-7 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">视频分离功能待接入</p>
      </div>
    </main>
  );
}
