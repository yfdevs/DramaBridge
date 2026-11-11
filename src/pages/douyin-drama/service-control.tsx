import { useAccountSelection, AccountSelection } from "@/pages/shared/account-selection"
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import {
  douyinDramaService,
  type DouyinDramaServiceStatus,
} from "@/platforms/douyin-drama/service"

const initialStatus: DouyinDramaServiceStatus = {
  platform: "douyin-drama",
  running: false,
  createUrl:
    "https://www.shortdramas.com/page/copyright/short-play/motion-comic-manage-edit-page/?from=book",
  loginUrl:
    "https://www.shortdramas.com/page/login?redirect=%2Fcopyright%2Fshort-play%2Fmotion-comic-manage-edit-page%2F%3Ffrom%3Dbook",
  accounts: [],
  pid: null,
}

export function DouyinDramaServiceControlPage() {
  const selection = useAccountSelection(douyinDramaService)

  const serviceState = useServiceControl({
    initialStatus,
    service: selection.service,
    successMessage: (status) => status.running
      ? `抖音短剧服务已启动 ${status.accounts.filter((account) => account.launched).length} 个账号浏览器`
      : "抖音短剧服务已停止",
  })

  return (
    <ServiceControlButtonPage
      analyticsPlatform="douyin-drama"
      startDisabled={selection.startDisabled}
      beforeBrowserInstances={<AccountSelection controls={douyinDramaService.accountControl} runtimes={serviceState.status.accounts} selection={selection} locked={serviceState.loading || serviceState.status.running} />}
      loading={serviceState.loading}
      pendingAction={serviceState.pendingAction}
      running={serviceState.status.running}
      onToggle={() => void serviceState.toggleService()}
    />
  )
}
