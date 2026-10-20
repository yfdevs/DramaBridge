# @dramabridge/iqiyi-drama-automation

爱奇艺创作者平台自动化运行时，按任务类型分别进入：

- 短剧：`https://creator.iqiyi.com/miniPlay/project/create`
- 漫剧：`https://creator.iqiyi.com/comicPlay/project/create`

## 素材策略

- 真人短剧和漫剧都必须上传第 1 集至 `episodeCount` 集正片；任务带百度网盘链接时会先下载素材。缺集、重复集数或集数不连续会直接失败。
- 正片使用页面的多文件控件分批选择（每批最多 50 集），临时文件名统一为 `<title>-第N集.mp4`，并等待页面生成的剧集行数、文件名和上传成功终态全部匹配后才继续。爱奇艺页面建议正片使用不低于 1080p 的 SDR 版本。
- 百度网盘任务负责准备封面/海报和正片视频；出品方证明材料严格来自任务字段，不扫描或混入百度网盘权属目录。
- 版权材料只读取 `copyright.productionProofFiles`，并且只上传到“知识产权声明文件”；会上传数组内的全部文件，不截断为首个文件。支持 JPG、PNG、PDF（BMP/WebP 会先转成 JPEG），最多 20 个、单个不超过 20MB。
- 竖版封面标准化为 `1080×1440`；未提供横版封面时，通过全局 AI 图片生成模型参考竖图生成横图，再标准化为 `1920×1080`。AI 必须在生成海报时直接绘制准确的中文剧名，并根据剧情自动使用海洋奇幻、古装、悬疑、甜宠、都市或漫剧等商业海报艺术字效果，不使用程序后期叠字。封面都会压缩到 5MB 以内。
- AI 横图按原图内容、模型和提示词版本缓存到平台运行数据目录。

## 任务字段

`payloadJson` 只接受管理端生成的标准结构：通用版权文件位于 `copyright`，爱奇艺字段位于 `iqiyiPlaylet`。不读取根级爱奇艺字段、`playlet`、`iqiyiExtraInfo` 或旧字段别名。

- `dramaType` 只接受 `short-drama` / `comic-drama`。
- `title`（不超过 30 字）、`summary`（100–300 字）、`episodeCount`。
- 一句话推荐无需任务返回：`title` 长度为 4–10 个字符时直接使用；不在该范围时调用全局 AI 文本模型生成严格为 4–10 个汉字的新推荐语，并在填写前校验，输出不合格时最多重试 3 次。
- `productionOrganization`：出品方名称。
- `productionCostYuan`：制作成本，单位为元。
- 定时上线无需任务返回，运行时取执行时间的次日并精确到秒；发行日期取执行当天。
- `baiduPanResourceLink`：用于下载封面和第 1～`episodeCount` 集正片；未提供时必须已经在本地素材根目录准备同名剧目目录及完整剧集。
- `verticalCoverFile`, `horizontalCoverFile`, `copyright.productionProofFiles`；文件值可为本地路径或 HTTP(S) 地址。
- 漫剧字段：`audienceType`（男频/女频/平衡）、`visualType`、`contentSource`、`secondaryCategories`（漫剧大标签）。
- 短剧字段：`audienceType`（仅男频/女频）、`secondaryCategories`（短剧标签）、`paymentStatus`（付费/免费）。付费短剧额外要求 `convertibleToFree` 和 `paidStartEpisode`；免费短剧禁止携带这两个付费专属字段。
- 导演、制片人、编剧、演员等选填页面字段不进入任务契约，自动化不会填写。
- 制作声明固定选择“含AI生成内容”；制作方固定选择“无制作方”；联合出品方固定选择“无联合出品方”；签约意向固定选择下拉中的第一项，均不接收任务字段。
- 所有必填页签完成并确认全部正片上传成功后，固定点击“提交项目”，不接收保存草稿或提交开关。

AI 的 API Key、Base URL、文本理解模型和图片生成模型都由 Electron 主进程从全局 `electron-store` 配置注入，运行时不读取业务环境变量。
