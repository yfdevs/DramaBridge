import { useAccountSelection, AccountSelection } from "@/pages/shared/account-selection"
import {
  ServiceControlButtonPage,
  useServiceControl,
} from "@/pages/shared/service-control"
import {
  iqiyiDramaService,
  type IqiyiDramaServiceStatus,
} from "@/platforms/iqiyi-drama/service"

const initialStatus: IqiyiDramaServiceStatus = {
  platform: "iqiyi-drama",
  running: false,
  shortDramaCreateUrl: "https://creator.iqiyi.com/miniPlay/project/create",
  comicDramaCreateUrl: "https://creator.iqiyi.com/comicPlay/project/create",
  loginUrl: "https://creator.iqiyi.com/?from=https%3A%2F%2Fcreator.iqiyi.com%2FcomicPlay%2Fproject%2Fcreate&showLogin=1",
  accounts: [],
  pid: null,
}

function successMessage(status: IqiyiDramaServiceStatus) {
  const count = status.accounts.filter((account) => account.launched).length
  return status.running
    ? `爱奇艺服务已启动 ${count} 个账号浏览器`
    : "爱奇艺服务已停止"
}

export function IqiyiDramaServiceControlPage() {
  const selection = useAccountSelection(iqiyiDramaService)

  const control = useServiceControl({
    initialStatus,
    service: selection.service,
    successMessage,
  })

  return (
    <ServiceControlButtonPage
      analyticsPlatform="iqiyi-drama"
      startDisabled={selection.startDisabled}
      beforeBrowserInstances={<AccountSelection controls={iqiyiDramaService.accountControl} runtimes={control.status.accounts} selection={selection} locked={control.loading || control.status.running} />}
      loading={control.loading}
      pendingAction={control.pendingAction}
      running={control.status.running}
      onToggle={() => void control.toggleService()}
    />
  )
}
