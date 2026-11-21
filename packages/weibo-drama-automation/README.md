# 微博短剧自动化

独立平台 `weibo-drama`，发布入口为 <https://duanju.mcn.weibo.com/content/series/publish>。

## 任务协议

沿用 QQ 的账号任务协议，接口前缀为 `/dramaAiRpa/weibo`：

| 用途                | 请求                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| 启用账号分页        | `POST /accountConfig/page`                                                        |
| 当前账号 READY 任务 | `POST /accountTask/page`                                                          |
| 原子领取            | `POST /rpa/claim`，`{ accountTaskId }`                                            |
| 结果回报            | `POST /rpa/report`，`{ taskId, success, failStage?, errorMessage?, resultJson? }` |

返回结构沿用 `{ code: 0, data, msg? }`；分页 data 为 `{ data: [], total }`。领取结果包含 `accountTaskId`、`accountId`、`originalTitle`、`payloadJson`。`payloadJson` 可为 JSON 对象或字符串：

```json
{
  "platform": "weibo",
  "name": "剧名",
  "summary": "内容简介（最多500字）",
  "episodeCount": 59,
  "baiduPanResourceLink": "百度网盘资源链接",
  "weiboPlaylet": {
    "collectionCategory": "AI动漫类",
    "audienceType": "男频",
    "subjectTypes": ["都市"],
    "eraBackground": "现代",
    "plotThemes": ["逆袭"],
    "roleSettings": ["大男主"]
  }
}
```

管理前端 `misu-ad-center` 使用相同前缀管理账号、绑定剧目账号和生成任务。接口已对照服务端 Swagger 的“短剧AI RPA 微博平台接口”核验，包含账号CRUD、任务分页/补齐/重试、绑定、审核状态、领取和回写等15个接口。领取返回的 `workerId`、`attemptCount` 如有值会原样回传；成功结果把已验证的合集ID同时写入 `externalId`、`platformDramaId` 和 `resultJson.albumId`，供后台任务详情展示和后续同步使用。

账号名称是服务端可选字段，未填写时界面使用UID；不会因为缺少显示名称而拒绝加载账号。`payloadJson` 继续使用下述业务结构，Swagger对该字段的定义是JSON对象。

2026-11-18后端连通性检查：微博账号分页、任务分页均可到达（HTTP 200），但返回 `{ code: 500, msg: "系统异常" }`；相同请求格式的QQ接口返回业务码0。当前服务端业务错误未解决前无法完成真实任务领取/回写联调，运行时会明确提示接口错误，不会当作“暂无任务”。

## 发布行为

- 后台任务账号ID与微博发布UID分开处理：优先精确匹配UID；后台账号ID为登录手机号等业务标识时，以配置的账号名称唯一匹配微博返回的发布账号。同名多个账号或名称不匹配会明确报错，不会默认选择第一个账号；提交后按实际微博UID核验。
- 登录时处理独立 `passport.weibo.com/sso/` 弹窗；以已认证的 `editInfoV2` 返回且包含所选 UID 为准，表单可见或弹窗关闭均不代表登录成功。
- 主演“无”；版权方、导演、制作人、编剧均“明星说”；单集时长1分钟；剪辑集数全部；卡点第5集，所以总集数至少5集。
- 题材最多2个，情节主题最多3个，角色设定最多2个。后台选项来自2026-11-18观察到的微博 `editInfoV2`。
- 版权材料从本剧素材目录匹配剪映、剧创等权属图片，最多5张；没有时上传1张封面。封面和证明文件按平台大小限制准备上传副本。
- 按文件名匹配完整剧集并排序。上传前检测视频尺寸，短边不足1080时生成1080p副本；原素材不覆盖。
- 临时上传错误按配置重试；分辨率错误尝试转换；编码、权限等错误提示具体集数与原因。替换失败集后恢复原顺序，无法确认顺序时停止提交。
- 提交后至少等待10秒，并核验合集名称、发布UID、完整集数和每集审核/发布状态。失败页面默认保留，可在微博配置关闭。

## 检查

```sh
pnpm weibo-drama:check
pnpm weibo-drama:test
pnpm weibo-drama:build
```

2026-11-18实测：原始720×1280视频被微博拒绝；转换到1080×1920后，《借地堆砖竟被拆墙占家》59集全部上传并提交成功。合集24121显示“上线中”，接口核验59集状态均为2，集号连续1–59，发布UID与所选账号一致。另用第二部剧验证5张权属图片均上传成功；无权属文件时的1张封面兜底也已验证。后台真实任务领取与回调仍受上述服务端业务码500阻塞。
