import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import { taobaoDramaService, type TaobaoDramaServiceStatus } from "@/platforms/taobao-drama/service"

const initialStatus: TaobaoDramaServiceStatus = {
  platform: "taobao-drama",
  running: false,
  collectionCreateUrl: "https://creator.guanghe.taobao.com/page/unify/collect-create",
  batchPublishUrl: "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish",
  loginUrl: "https://login.taobao.com/",
  accounts: [],
  pid: null,
}

export function TaobaoDramaServiceControlPage() {
  const state = useServiceControl({
    initialStatus,
    service: taobaoDramaService,
    successMessage: (status) => status.running ? "淘宝合集创建与上传服务已启动" : "淘宝合集创建与上传服务已停止",
  })
  return (
    <ServiceControlButtonPage
      analyticsPlatform="taobao-drama"
      loading={state.loading}
      pendingAction={state.pendingAction}
      running={state.status.running}
      onToggle={() => void state.toggleService()}
    />
  )
}
