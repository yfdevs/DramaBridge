import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { WorkspacePageActivity } from "@/components/workspace-toolbar";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { YoutubeCreateTaskPage } from "./create-task";

export function YoutubeCreateTaskDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (pathname === "/youtube-drama/create") {
      setOpen(true);
      navigate("/youtube-drama/service", { replace: true });
    }
  }, [pathname, navigate]);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
      swipeDirection="right"
    >
      {children}
      <DrawerContent className="youtube-theme duration-250 ease-out data-[swipe-axis=x]:[--drawer-content-width:100%] data-[swipe-axis=x]:sm:[--drawer-content-width:640px]">
        <DrawerHeader className="shrink-0 p-5 text-left">
          <DrawerTitle>添加任务</DrawerTitle>
          <DrawerDescription className="sr-only">
            填写剧目素材和上传设置，加入 YouTube 任务队列
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto select-text">
          <WorkspacePageActivity active={open}>
            <YoutubeCreateTaskPage
              embedded
              onCancel={() => setOpen(false)}
              onCreated={() => {
                setOpen(false);
                window.dispatchEvent(new Event("youtube:tasks-changed"));
              }}
              onBusyChange={setBusy}
            />
          </WorkspacePageActivity>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
