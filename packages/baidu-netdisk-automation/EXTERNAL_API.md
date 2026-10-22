# 百度网盘本机 API 对接

本接口由 DramaBridge 桌面应用中的 Express 服务提供，供同一台电脑上的 Python、Java 等程序使用。API 复用现有百度网盘客户端、CDP 连接和操作队列，不需要调用方连接 CDP。

## 1. 开启服务

在“全局配置 → 本机接口服务”中打开“开启接口服务”。开关立即生效并自动保存，应用下次启动时自动恢复服务。

- 默认地址：`http://127.0.0.1:18439/api`，端口可修改。
- 无需密钥、Token 或登录鉴权，本机程序可直接调用。
- 修改端口后点击“应用设置”，无需重启应用。
- 仅监听本机回环地址；不向局域网直接提供服务。不允许带 `Origin` 的浏览器跨站请求。
- 关闭接口停止接受调用、断开正在等待的 HTTP 请求；已受理的下载与回调仍继续。重新开启后可以查询它们。
- 应用退出后服务不可用。应用重启时，未完成任务标为 `interrupted`；调用重试接口继续，执行时重新检查本地资源。
- 开启 HTTP 服务不等于百度客户端已登录；通过状态接口检查，必要时调用启动接口，并在客户端完成登录。

接口配置独立于平台配置和其他全局设置；接口启动失败（如端口被占用）不会停止已有平台服务。

## 2. 请求约定

接口无需鉴权。POST 请求需设置：

```http
Content-Type: application/json
```

请求体上限为 64 KiB。没有参数的 POST 请求发送 `{}`。接口不接受任意 CDP 指令或客户端脚本。

成功响应：

```json
{"success":true,"data":{"taskId":"...","status":"queued"}}
```

参数或请求格式错误响应：

```json
{"success":false,"error":{"code":"INVALID_REQUEST","message":"具体错误原因"}}
```

## 3. 接口列表

下表路径均相对于 `http://127.0.0.1:18439`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 检查 HTTP 服务是否可用 |
| GET | `/api/baidu-netdisk/status` | 检查百度网盘、CDP 是否就绪 |
| POST | `/api/baidu-netdisk/start` | 启动百度网盘 CDP 服务，不代替用户登录 |
| POST | `/api/baidu-netdisk/downloads` | 异步受理下载任务 |
| POST | `/api/baidu-netdisk/downloads?wait=true` | 在同一次 HTTP 请求中等待最终结果 |
| GET | `/api/baidu-netdisk/downloads` | 返回最近 100 个外部下载任务 |
| GET | `/api/baidu-netdisk/downloads/{taskId}` | 查询任务、进度、结果与回调投递状态 |
| POST | `/api/baidu-netdisk/downloads/{taskId}/retry` | 重试失败、超时、中断的任务 |
| POST | `/api/baidu-netdisk/downloads/{taskId}/pause` | 暂停运行中的客户端下载任务 |
| POST | `/api/baidu-netdisk/downloads/{taskId}/resume` | 恢复运行中的客户端下载任务 |

## 4. 提交任务

推荐使用异步任务加 `callbackUrl`，无需一直轮询。

```http
POST /api/baidu-netdisk/downloads
Content-Type: application/json
```

```json
{
  "requestId": "my-program-order-001",
  "shareText": "https://pan.baidu.com/s/分享ID?pwd=提取码",
  "resourceName": "测试短剧",
  "episodeCount": 60,
  "timeoutSeconds": 1800,
  "callbackUrl": "http://127.0.0.1:8008/netdisk-callback"
}
```

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `requestId` | string | 是 | 调用方生成的幂等编号，1～128 字符 |
| `shareText` | string | 是 | 百度 `/s/` 分享链接及提取码（放在链接的 `pwd` 参数，或分享文本的“提取码：xxxx”中），最多 4096 字符 |
| `resourceName` | string | 是 | 本地资源目录名称，最多 100 字符，不得包含路径分隔符或 Windows 非法文件名 |
| `episodeCount` | integer | 条件必填 | 预期集数，1～10000；下载视频时必须提供，或开启自动识别 |
| `inferEpisodeCount` | boolean | 否 | 默认 `false`；设为 `true` 可自动识别集数 |
| `downloadEpisodeVideos` | boolean | 否 | 默认 `true`，是否下载视频 |
| `downloadAssetMaterials` | boolean | 否 | 默认 `true`，是否下载素材 |
| `requiredPosterImages` | integer | 否 | 最少海报图片数，默认 0，范围 0～100 |
| `timeoutSeconds` | number | 否 | 每次任务的总时限，默认 3600 秒，必须大于 0 且不超过 86400 秒；允许小数 |
| `callbackUrl` | string | 否 | HTTP/HTTPS 回调地址，最多 2048 字符；不能包含 URL 用户名、密码或片段，不跟随重定向 |

不接受未知参数。下载目录由应用的“素材目录”配置决定，调用方不能传任意本地路径。

首次受理返回 HTTP 202：

```json
{
  "success": true,
  "data": {
    "taskId": "7182106a-980d-4e1e-8802-53998b5d20d7",
    "requestId": "my-program-order-001",
    "resourceName": "测试短剧",
    "status": "queued",
    "createdAt": "2026-10-22T08:00:00.000Z",
    "updatedAt": "2026-10-22T08:00:00.000Z",
    "deadlineAt": "2026-10-22T08:30:00.000Z",
    "timeoutSeconds": 1800
  }
}
```

短任务可能在响应前已进入 `running` 或 `completed`，调用方应按返回状态处理。

### 幂等与重试

- 相同 `requestId`、相同参数再次提交：HTTP 200，返回原任务，不重复下载。
- 相同 `requestId`、不同参数：HTTP 409 `REQUEST_ID_CONFLICT`。修改超时或回调地址也算参数变化。
- 原任务失败后，重复原提交仍返回原失败状态；需要显式调用 `/retry`，或使用新的 `requestId`。
- `/retry` 复用原任务编号和请求参数，重新计算截止时间，不覆盖已完成任务。
- 超时任务的旧操作尚在清理时，重试返回 HTTP 409 `TASK_STOPPING`，稍后再试。

## 5. 超时语义

`timeoutSeconds` 从任务受理时开始，包含外部队列等待、网盘操作、下载和校验。暂停下载不会暂停计时。

- 异步模式：任务超时后状态为 `timed_out`、错误码为 `DOWNLOAD_TIMEOUT`；查询返回该终态，配置回调时会通知调用方。
- `?wait=true`：等待超时会返回 HTTP 504，格式如下。网络客户端的读取超时需略大于 `timeoutSeconds`。
- 发出中止信号后，底层客户端可能还需要时间取消与清理；任务结果已经固定为超时，迟到的完成结果不会改成成功。
- 回调投递独立计时，不占用下载超时时限。
- `wait=true` 连接断开不等于取消任务；可按原 `requestId` 找回任务。

```json
{
  "success": false,
  "data": {
    "taskId": "7182106a-980d-4e1e-8802-53998b5d20d7",
    "requestId": "my-program-order-001",
    "resourceName": "测试短剧",
    "status": "timed_out",
    "timeoutSeconds": 1800,
    "error": {
      "code": "DOWNLOAD_TIMEOUT",
      "message": "下载任务超过 1800 秒，已超时（包含排队时间）"
    }
  }
}
```

同步等待下载失败返回 HTTP 422，最终任务位于 `data`，并包含 `error`。参数或请求格式错误的原因则位于顶层 `error`。

## 6. 查询状态与读取文件

```http
GET /api/baidu-netdisk/downloads/{taskId}
```

查询请求成功时 HTTP 200；`data.status` 表示下载结果，不能仅根据查询的 HTTP 状态判断下载成功。

| `status` | 含义 |
| --- | --- |
| `queued` | 已受理，正在排队 |
| `running` | 执行中，暂停时也保持此状态，以 `progress.nativeStatus` 辅助判断 |
| `completed` | 下载与本地校验完成，可以读取 `result.localPath` |
| `failed` | 执行失败，读取 `error` |
| `timed_out` | 超过本次任务的时限 |
| `interrupted` | 应用退出或重启导致工作流中断，需要显式重试 |

运行中可能附带：

```json
{"progress":{"percent":50,"transferredBytes":102400,"totalBytes":204800,"speedText":"2 MB/s","nativeStatus":"..."}}
```

进度信息依赖客户端提供的状态，部分字段可能不存在。成功结果示例：

```json
{
  "result": {
    "downloadRecordId": "...",
    "localPath": "D:\\素材\\__external_api_downloads__\\分享标识\\测试短剧",
    "episodeCount": 60,
    "skippedExisting": false
  }
}
```

调用方在同一台电脑上按 `localPath` 读取文件。`episodeCount` 未显式提供时，结果中可能省略该字段。

外部任务记录保存在应用数据库中。外部文件位于素材目录的 `__external_api_downloads__` 子目录，与内部上剧素材分开，不参与上剧目录的自动清理；使用方自行管理这些文件的保留时间。删除文件后，历史 `completed` 记录不会自动回退为失败。

## 7. 异步回调

配置 `callbackUrl` 后，任务进入终态时会向该地址发送 POST JSON：

```json
{
  "eventId": "7182106a-980d-4e1e-8802-53998b5d20d7:1",
  "event": "download.completed",
  "taskId": "7182106a-980d-4e1e-8802-53998b5d20d7",
  "requestId": "my-program-order-001",
  "resourceName": "测试短剧",
  "status": "completed",
  "result": {"localPath":"D:\\素材\\__external_api_downloads__\\分享标识\\测试短剧","skippedExisting":false}
}
```

事件类型为 `download.completed`、`download.failed`、`download.timed_out`、`download.interrupted`。实际载荷还包含时间、超时和回调投递状态字段；失败事件包含 `error`，没有成功结果。

接收端要求：

1. 读取 JSON 中的 `eventId` 和任务结果。
2. 持久化接收结果，按 `eventId` 去重。
3. 尽快返回任意 2xx。耗时业务在接收端后台执行。

回调直接发送 JSON，无需密钥、鉴权或签名校验。

每次回调最长等待 10 秒，失败最多投递 3 次，重试间隔依次为 1 秒、2 秒；HTTP 非 2xx、超时或重定向均算失败。投递可能重复，`eventId` 在同一轮下载的重投中保持一致，格式为 `taskId:attempt`。显式重试下载时 `attempt` 加 1，新的结果使用新的事件编号。

查询任务可检查 `callback.status`：`pending`、`delivered`、`failed`，并查看 `attempts` 和最近的 `error`。回调失败不会重下文件，也不会把已经成功的下载改成失败。应用启动会继续处理未完成的回调；终止进程可能导致一次回调被重复接收。

## 8. Python 示例（标准库）

下面的示例开启本机回调接收器、提交下载，接收下载结果回调。示例未实现持久化去重；正式接入时应按 `eventId` 持久化接收结果并去重。

```python
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:18439/api"
REQUEST_ID = str(uuid.uuid4())
done = threading.Event()

class CallbackHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if self.path != "/netdisk-callback" or size > 1024 * 1024:
            self.send_error(400)
            return
        raw = self.rfile.read(size)
        event = json.loads(raw)
        print("回调结果:", event)
        # 正式业务：持久化结果并按 eventId 去重，再返回 2xx。
        self.send_response(200)
        self.end_headers()
        if event.get("requestId") == REQUEST_ID:
            done.set()

server = ThreadingHTTPServer(("127.0.0.1", 8008), CallbackHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    payload = {
        "requestId": REQUEST_ID,
        "shareText": "https://pan.baidu.com/s/替换为实际分享链接?pwd=1234",
        "resourceName": "测试短剧",
        "episodeCount": 60,
        "timeoutSeconds": 600,
        "callbackUrl": "http://127.0.0.1:8008/netdisk-callback",
    }
    req = Request(BASE + "/baidu-netdisk/downloads",
                  data=json.dumps(payload, ensure_ascii=False).encode(),
                  headers={"Content-Type": "application/json"},
                  method="POST")
    with urlopen(req, timeout=15) as response:
        task = json.load(response)["data"]
    print("任务已受理:", task["taskId"])
    if not done.wait(660):
        query = Request(BASE + "/baidu-netdisk/downloads/" + task["taskId"])
        with urlopen(query, timeout=15) as response:
            print("查询任务与回调状态:", json.load(response))
finally:
    server.shutdown()
    server.server_close()
```

不需要回调时，省略 `callbackUrl` 并轮询任务；若使用 `?wait=true`，可将 `urlopen` 的读取超时设为例如 `timeoutSeconds + 15`。HTTP 504 会以 `urllib.error.HTTPError` 抛出，可通过 `error.read()` 获取任务超时 JSON。

## 9. Java 17 示例（标准库）

保存为 `NetdiskClient.java`，填写分享链接后运行 `javac NetdiskClient.java`、`java NetdiskClient`。示例在 8008 端口接收回调；实际项目应解析 JSON 并持久化 `eventId` 与结果。

```java
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public class NetdiskClient {
    public static void main(String[] args) throws Exception {
        var done = new CompletableFuture<String>();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 8008), 0);
        server.createContext("/netdisk-callback", exchange -> {
            try {
                byte[] raw = exchange.getRequestBody().readAllBytes();
                String body = new String(raw, StandardCharsets.UTF_8);
                // 正式业务：解析并持久化结果，按 eventId 去重后再返回 2xx。
                done.complete(body);
                exchange.sendResponseHeaders(200, -1);
            } catch (Exception error) {
                exchange.sendResponseHeaders(500, -1);
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            String payload = """
                {"requestId":"%s",
                 "shareText":"https://pan.baidu.com/s/替换为实际分享链接?pwd=1234",
                 "resourceName":"测试短剧","episodeCount":60,"timeoutSeconds":600,
                 "callbackUrl":"http://127.0.0.1:8008/netdisk-callback"}
                """.formatted(UUID.randomUUID());
            var request = HttpRequest.newBuilder(URI.create(
                    "http://127.0.0.1:18439/api/baidu-netdisk/downloads"))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8)).build();
            var response = HttpClient.newHttpClient().send(request,
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            System.out.println("提交响应：" + response.statusCode() + " " + response.body());
            if (response.statusCode() >= 400) throw new IllegalStateException(response.body());
            System.out.println("回调结果：" + done.get(660, TimeUnit.SECONDS));
        } finally {
            server.stop(0);
        }
    }
}
```

## 10. 常见错误

| HTTP / 错误码 | 说明 |
| --- | --- |
| 400 `INVALID_REQUEST` | 请求字段或参数范围不正确 |
| 400 `INVALID_JSON` | JSON 格式不正确 |
| 403 `ORIGIN_NOT_ALLOWED` / `INVALID_HOST` | 浏览器跨站请求或 Host 不匹配 |
| 404 `TASK_NOT_FOUND` / `NOT_FOUND` | 任务或接口不存在 |
| 409 `REQUEST_ID_CONFLICT` | 幂等编号对应的参数不同 |
| 409 `TASK_STOPPING` | 上一次超时操作还在结束，请稍后重试 |
| 409 `TASK_NOT_RUNNING` | 任务当前不能暂停或恢复 |
| 413 `REQUEST_TOO_LARGE` | JSON 请求体超过 64 KiB |
| 415 `JSON_REQUIRED` | POST 没有使用 JSON Content-Type |
| 422，任务 `DOWNLOAD_FAILED` | 同步等待得到执行失败，查看 `data.error.message` |
| 504，任务 `DOWNLOAD_TIMEOUT` | 同步等待超过任务时限 |
| 503 `SERVICE_STOPPED` | HTTP 服务关闭，原等待请求结束 |

使用分享链接或提取码错误、客户端未登录、资源缺集、本地空间不足等情况，读取任务的 `error.message` 获取具体原因。
