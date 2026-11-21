import { FailureTooltip } from "@/components/ui/failure-tooltip";
import { useAccountSelection, AccountSelection } from "@/pages/shared/account-selection"
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import { baiduDramaService, type BaiduDramaServiceStatus } from "@/platforms/baidu-drama/service"

const initialStatus: BaiduDramaServiceStatus = {
  platform: "baidu-drama",
  running: false,
  createUrl: "https://duanju.baidu.com/builder/rc/edit?type=playlet&sub_type=create_playlet_type&action=new",
  loginUrl: "https://duanju.baidu.com/builder/theme/playletPlat/product",
  accounts: [],
  pid: null,
}

function successMessage(status: BaiduDramaServiceStatus) {
  const browserCount = status.accounts.filter((account) => account.launched).length
  return status.running
    ? `百度短剧服务已启动 ${browserCount} 个账号浏览器`
    : "百度短剧服务已停止"
}

export function BaiduDramaServiceControlPage() {
  const selection = useAccountSelection(baiduDramaService)
  const serviceState = useServiceControl({
    initialStatus,
    service: selection.service,
    successMessage,
  })

  return (
    <ServiceControlButtonPage

      startDisabled={selection.startDisabled}
      beforeBrowserInstances={<>
        <AccountSelection controls={baiduDramaService.accountControl} runtimes={serviceState.status.accounts} selection={selection} locked={serviceState.loading || serviceState.status.running} />
        {serviceState.status.accounts.some(account => account.statusMessage) && (
          <ul className="space-y-2 text-xs" aria-label="百度任务领取状态" aria-live="polite">
            {serviceState.status.accounts.filter(account => account.statusMessage).map(account => (
              <li key={account.accountId} className="min-w-0">
                <FailureTooltip reason={account.runtimeError}><span className="block max-w-full truncate">{account.accountName}：{account.statusMessage}</span></FailureTooltip>
              </li>
            ))}
          </ul>
        )}
      </>}
      loading={serviceState.loading}
      pendingAction={serviceState.pendingAction}
      running={serviceState.status.running}
      onToggle={() => void serviceState.toggleService()}
    />
  )
}
