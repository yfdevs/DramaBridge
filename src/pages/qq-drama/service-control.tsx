import { useAccountSelection, AccountSelection } from "@/pages/shared/account-selection"
import {
  ServiceControlButtonPage,
  useServiceControl,
} from "@/pages/shared/service-control"
import {
  qqDramaService,
  type QqDramaServiceStatus,
} from "@/platforms/qq-drama/service"

const initialStatus: QqDramaServiceStatus = {
  platform: "qq-drama",
  running: false,
  addUrl: "https://aishortdrama.qq.com/cpplatform#/drama/add",
  loginUrl: "https://aishortdrama.qq.com/cpplatform#/login",
  accounts: [],
  pid: null,
}

function successMessage(status: QqDramaServiceStatus) {
  const browserCount = status.accounts.filter((account) => account.launched).length
  return status.running
    ? `QQ 短剧服务已启动 ${browserCount} 个账号浏览器`
    : "QQ 短剧服务已停止"
}

export function QqDramaServiceControlPage() {
  const selection = useAccountSelection(qqDramaService)

  const {
    loading,
    pendingAction,
    status,
    toggleService,
  } = useServiceControl({
    initialStatus,
    service: selection.service,
    successMessage,
  })

  return (
    <ServiceControlButtonPage
      analyticsPlatform="qq-drama"
      startDisabled={selection.startDisabled}
      beforeBrowserInstances={<AccountSelection runtimes={status.accounts} selection={selection} locked={loading || status.running} />}
      loading={loading}
      pendingAction={pendingAction}
      running={status.running}
      onToggle={() => void toggleService()}
    />
  )
}
