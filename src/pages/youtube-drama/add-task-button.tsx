import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DrawerTrigger } from "@/components/ui/drawer";
import { isYoutubeWeb } from "@/platforms/youtube-drama/service";

export function YoutubeAddTaskButton({ className }: { className?: string }) {
  return isYoutubeWeb ? (
    <DrawerTrigger render={<Button size="sm" className={className} />}>添加任务</DrawerTrigger>
  ) : (
    <Button size="sm" className={className} nativeButton={false} render={<Link to="/youtube-drama/create" />}>
      添加任务
    </Button>
  );
}
