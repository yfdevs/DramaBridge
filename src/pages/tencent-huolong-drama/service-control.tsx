import { useAccountSelection, AccountSelection } from "@/pages/shared/account-selection"
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import {
  tencentHuolongDramaService,
  type TencentHuolongDramaServiceStatus,
} from "@/platforms/tencent-huolong-drama/service"

const initialStatus: TencentHuolongDramaServiceStatus = {
  platform: "tencent-huolong-drama",
  running: false,
  addUrl: "https://mp.v.qq.com/kairos/album/create",
  loginUrl: "https://mp.v.qq.com/",
  accounts: [],
  pid: null,
}

export function TencentHuolongDramaServiceControlPage() {
  const selection = useAccountSelection(tencentHuolongDramaService)

  const state = useServiceControl({
    initialStatus,
    service: selection.service,
    successMessage: (status) => status.running
      ? `腾讯火龙漫剧服务已启动 ${status.accounts.filter((account) => account.launched).length} 个账号浏览器`
      : "腾讯火龙漫剧服务已停止",
  })
  return (
    <ServiceControlButtonPage
      analyticsPlatform="tencent-huolong-drama"
      startDisabled={selection.startDisabled}
      beforeBrowserInstances={<AccountSelection runtimes={state.status.accounts} selection={selection} locked={state.loading || state.status.running} />}
      loading={state.loading}
      pendingAction={state.pendingAction}
      running={state.status.running}
      onToggle={() => void state.toggleService()}
    />
  )
}
