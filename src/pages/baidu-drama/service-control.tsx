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
      analyticsPlatform="baidu-drama"
      startDisabled={selection.startDisabled}
      beforeBrowserInstances={<AccountSelection runtimes={serviceState.status.accounts} selection={selection} locked={serviceState.loading || serviceState.status.running} />}
      loading={serviceState.loading}
      pendingAction={serviceState.pendingAction}
      running={serviceState.status.running}
      onToggle={() => void serviceState.toggleService()}
    />
  )
}
