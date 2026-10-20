import { CloudUpload } from "@mynaui/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import {
  type PinduoduoDramaServiceStatus,
  pinduoduoDramaService,
} from "@/platforms/pinduoduo-drama/service";

const initialStatus: PinduoduoDramaServiceStatus = {
  platform: "pinduoduo-drama",
  running: false,
  loginState: "unknown",
  manageUrl: "https://mcn.pinduoduo.com/home/shortplayManage",
  loginExpiredUrl: "https://mcn.pinduoduo.com/register",
  userDataDir: "",
  pid: null,
};

function successMessage(status: PinduoduoDramaServiceStatus) {
  return status.running ? "拼多多短剧已启动" : "拼多多短剧已停止";
}

export function PinduoduoDramaServiceControlPage() {
  const [openingRecords, setOpeningRecords] = useState(false);
  const { loading, pendingAction, status, toggleService } = useServiceControl({
    initialStatus,
    service: pinduoduoDramaService,
    successMessage,
  });

  const openUploadRecords = () => {
    void (async () => {
      setOpeningRecords(true);
      try {
        await pinduoduoDramaService.openUploadRecordsWindow();
      } catch (error) {
        toast.error("审核状态窗口打开失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setOpeningRecords(false);
      }
    })();
  };

  return (
    <>
      <ServiceControlButtonPage
        analyticsPlatform="pinduoduo-drama"
        loading={loading}
        pendingAction={pendingAction}
        running={status.running}
        additionalAction={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-3 text-xs"
            disabled={openingRecords}
            onClick={openUploadRecords}
          >
            <CloudUpload className="size-3.5" aria-hidden="true" />
            {openingRecords ? "打开中…" : "审核与上传状态"}
          </Button>
        }
        onToggle={() => void toggleService()}
      />
    </>
  );
}
