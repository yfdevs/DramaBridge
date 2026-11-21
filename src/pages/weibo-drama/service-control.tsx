import { useAccountSelection, AccountSelection } from "@/pages/shared/account-selection";
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import { weiboDramaService, type WeiboDramaServiceStatus } from "@/platforms/weibo-drama/service";

const initialStatus: WeiboDramaServiceStatus = {
  platform: "weibo-drama",
  running: false,
  addUrl: "https://duanju.mcn.weibo.com/content/series/publish",
  loginUrl: "https://duanju.mcn.weibo.com/content/series/publish",
  accounts: [],
  pid: null,
};

function successMessage(status: WeiboDramaServiceStatus) {
  const browserCount = status.accounts.filter((account) => account.launched).length;
  return status.running
    ? `微博 短剧服务已启动 ${browserCount} 个账号浏览器`
    : "微博 短剧服务已停止";
}

export function WeiboDramaServiceControlPage() {
  const selection = useAccountSelection(weiboDramaService);

  const { loading, pendingAction, status, toggleService } = useServiceControl({
    initialStatus,
    service: selection.service,
    successMessage,
  });

  return (
    <ServiceControlButtonPage

      startDisabled={selection.startDisabled}
      beforeBrowserInstances={
        <AccountSelection
          controls={weiboDramaService.accountControl}
          runtimes={status.accounts}
          selection={selection}
          locked={loading || status.running}
        />
      }
      loading={loading}
      pendingAction={pendingAction}
      running={status.running}
      onToggle={() => void toggleService()}
    />
  );
}
