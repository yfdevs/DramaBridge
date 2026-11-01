# 百度网盘 8.9.7：同内容多版本的云端复制分析

分析日期：2026-10-30。目标是确认“首次上传、后续云端复制并指定名称”的实现依据。本次仅静态读取已安装客户端，不提交真实复制、重命名、删除请求，不关闭或重启客户端，不干扰正在运行的任务。

## 结论与证据强度

客户端确实实现了云端 `copy`，复制条目包含 `path`、`dest`、`newname`，因此实现“同内容只上传一次，后续以另一名称复制”有明确协议结构依据。客户端选择目标目录的 UI 当前会把源 basename 填入 `newname`；将该字段设为业务目标文件名是合理的实现推断，本次没有通过真实请求验证服务器接受所有名称组合。

直接复制请求使用 `/api/filemanager?async=0&onnest=fail&opera=copy&bdstoken=...`，POST 参数为 JSON 字符串 `filelist`。这里观察到的是同步复制 helper；不能把批量重命名组件的 `async=2` 无条件当作个人空间复制的已验证参数。

`/api/taskquery` 和 `/share/taskquery` 都存在，但属于不同调用路径。个人文件管理请求不应因发现 share 轮询代码就直接改用 `/share/taskquery`。成功受理、异步任务结束、每个条目成功、目标确实存在是不同阶段，需要分别处理。

没有运行证据证明所有云端复制都返回或保留相同 MD5。复制按产品语义应保持文件内容，这是推断；项目仍应使用本地内容指纹选择复用对象，并核对目标大小以及可用的 MD5/元数据，不能仅凭名称或顶层 errno 判定内容一致。

## 工件与 REA Evidence

安装目录：`C:/Users/maded/AppData/Roaming/baidu/BaiduNetdisk/module/BrowserEngine/resources/`。

| 工件 | SHA-256 |
| --- | --- |
| `core.asar` | `280214b601b9dd28b932879c931d7bc9735bfd39b231e99412327aa3ea8c71c2` |
| `app.asar` | `f4e24518e4ed7372a0235df2259084efef30cfdfd53d78bc94134eefdaf8a64f` |

本次实际调用 `REA analyze_javascript_application`，限定小源并按 summary 返回，未重复对巨大的 main.js 做超时分析：

| 范围 | 完整 Evidence | Summary Evidence | 解析覆盖 |
| --- | --- | --- | --- |
| `app.asar/node_modules/@baidu/disk-ee/components/batch-rename/src/utils/requestHelper.js` | `ev_34483c20e420d76b63b803ef908c0d6a71db27372518474b7caf287eb7372e96` | `ev_520b07ad89716a962da6b693309404fec2defa0f5fed7284092a2b74bad8865d` | 1 个 JS、384 AST 节点、3 findings、0 parse failures |
| `app.asar/.../batch-rename/src/mixins/taskMixin.js` 和 `src/constants.js` | `ev_8e70fec2ce7e1ae6e04ae13b0307d30b4631171141dcfcb8e866efb083ee5e98` | `ev_d780af9642f3cbfc6c594ba87f3eeb4c27b5bd9c156ebd4c2821bf0674746640` | 2 个 JS、7,673 bytes、929 AST 节点、31 findings、0 parse failures |
| `core.asar/101.js` | `ev_6e0599c3d6666368839a765c090bd78b7657a88cbb6b2a88ffb85626a68f72f1` | `ev_bc5f9bcd6f6078d49e2c1e54e9ef483184a3387119b9cfd6633d7ce70ad7fa1e` | 1 个 JS、49,520 bytes、8,570 AST 节点、5 findings、0 parse failures |

REA 只解析选定源，其余依赖没有自动展开；整个应用关系覆盖仍是 partial。101.js 的 semantic unknown retention 达到本次设置的上限（global 1000 / per-file 500），不代表已经恢复全部跨模块行为。后面的压缩文件偏移来自同工件通过 `@electron/asar` 的只读定向提取，单位为解码字符串的 UTF-16 索引，不是 ASAR 原始字节偏移。

## 复制条目的形状

`core.asar/101.js` UTF-16 约 32749 的目标目录确认逻辑：

```js
paths.forEach(function (sourcePath) {
  // newname 从源路径最后一个 / 后截取
  const item = { path: sourcePath, dest: selectedDirectory, newname: basename };
  filelist.push(item);
});
```

同源随后 UTF-16 约 34335 发送 `fileManager` IPC，载荷包含 `type`、`filelist`、`specialParams`。`core.asar/84.js` UTF-16 约 63987、65636 有相同的新 UI 逻辑。这里的 `dest` 是目标父目录，不是包含最终 basename 的完整目标文件路径。企业/多人空间另有 cid、tocid、uk、folderType 等字段，不能混入普通个人空间请求。

`core.asar/main.js` UTF-16 约 1078566 将此 IPC 转发到主 renderer，个人空间 channel 为 `fileManager`，企业空间为 `co_fileManager`。此处仅确认转发，不据此推断后续所有原生实现。

## 直接 copy helper 与路由绑定

`core.asar/renderer.js` UTF-16 1452601 附近：

```js
function h(filelist = [], token = "") {
  const query = { async: 0, onnest: "fail", opera: "copy", bdstoken: token };
  return http.post(`${resolveEndpoint(endpoints.W)}?${stringify(query)}`, {
    filelist: JSON.stringify(filelist)
  });
}
```

该模块 `o=n(2)`，module 2 的 export `W` 在 UTF-16 10812 映射到 `O`，路由表 UTF-16 22499 附近的 `[O]` 为 `https://pan.baidu.com/api/filemanager`；相邻 `[E]` 为 `/api/taskquery`。因此这是具体的个人文件管理复制请求，不只是一个未绑定的 copy 字符串。

`onnest:"fail"` 表明客户端选择了冲突失败策略；本次不据此推导覆盖、自动改名或已有文件重用的其他模式。项目宜使用失败策略并显式核对目标，防止替换用户已有文件。一次复制就提交 `newname` 可以减少单独 rename 请求，但是否支持所有同目录异名组合仍需项目实际运行验证。

## 重命名和异步响应的实际处理

REA 分析的 `requestHelper.js`：

- 第 11–16 行：输入为 `[{path,newname}]`。helper 对每项内部键值文本做 `encodeURIComponent`，再组合 `filelist=` 表单字符串。
- 第 22–41 行：默认 query 为 `channel=chunlei,clienttype=0,async=2,web=1,opera=rename`；可补充 app_id、bdstoken、extraParams。
- 第 118–126 行：POST 至调用方传入的 filemanagerUrl。
- 第 47–57、129–135 行：GET taskqueryUrl，参数至少 `taskid`，按配置添加 bdstoken、extraParams。
- 这是可注入 URL 的通用组件，示例采用企业/多人空间 `/mid_enterprise_v2/api/...`。不能仅凭此文件把企业组件全部参数直接复制到个人空间。

`taskMixin.js` 的响应语义：

1. 第 29 行：`errno === 0 && taskid` 只代表受理，保存 taskId 并轮询。
2. 第 35–36 行：`errno === 0 && list` 走同步逐条结果。
3. 第 70–75 行：轮询遇到 `status === 'success' || status === 'failed'` 都停止，再读取逐条结果；没有把整个 `failed` 响应的条目一概忽略。
4. 第 91–126 行：逐条通过 `item.from || item.path` 关联输入；错误值使用 `item.error_code || item.errno || 0`。0 成功、-30 名称冲突、其他值失败。顶层 errno 为 0 也可能存在单项失败。
5. `constants.js` 第 3–4 行：该组件 500ms 轮询，60s 超时。这是客户端 UI 的一条策略，不是服务器要求，不应作为项目必须高频轮询的依据。

另有 renderer UTF-16 1477424 附近的 generatePoll 默认请求 `/share/taskquery`（taskid、pending/running/success）。该实现位于分享转存相关路径，不能当作个人复制 endpoint 的证明。renderer UTF-16 3527624、3535055 的另一调用使用 `/api/taskquery`，处理 pending/running/success、task_errno 和约 2 秒间隔；功能上下文也不是本次直接 copy helper，故仅用来佐证任务状态词和失败分支存在。

## 项目实现建议

采用“任务内首个成功上传作为不可变源，其他相同内容版本复制到最终名称”的策略。源至少绑定当前账号、规范化网盘路径、文件大小、内容指纹；路径相同或版本序号相同不足以证明内容相同。已上传版本不应为了复用而被移动、改名或删除。

复制前核对源仍有效；复制后核对目标大小以及可用的 MD5/文件元数据。能够读取目标 MD5 时应对比已知源 MD5；拿不到 MD5 时必须记录验证能力有限，不能声称已经密码学验证云端字节。

复制响应带 taskid 时等待终态，检查 task_errno、逐条错误和目标结果；部分失败只降级相应条目。超时或网络中断可能发生在服务器已受理之后，应先查 taskid 或核对目标，避免盲目重放引入重复文件。

遇到此前已有的 8001/132 风控或验证状态继续暂停自动操作，不因为“复制比上传快”而提高重试或并发来绕过验证。对明确的源缺失、复制不支持、普通冲突等情况，才依据目标核对结果决定是否回退直接上传。风险状态、未知完成状态不应自动触发另一个写接口。

本次没有观察真实网络响应、复制后 MD5、账号鉴权状态、服务端限流策略；也没有证明单次复制请求的性能、最大条目数或可并发数量。以上静态证据支持减少重复上传的架构选择，实际吞吐与运行兼容性仍需项目自己的有界验证。

## 已接入项目的行为与验证

`electron/platforms/kuaishou-drama/recreation-workflow.ts` 将同任务内已成功分享且路径正确的其他版本作为候选源。`copy-version-files.ts` 在新鲜源目录列表和有效校验记录基础上，以相对分类目录、大小、内容 MD5 匹配；文件名称不同不会阻止复用，内容不同则保留原有分片上传。

复制使用上述同步 copy 参数和最终 `newname`，每批最多 50 项（项目保守默认，不是已证实的服务器限制）。已存在目标须先校验；不覆盖源或目标。若返回 taskid，等待个人空间 `/api/taskquery` 终态，并检查 `task_errno`、逐项错误。复制后重新列目录，核对源未变化与目标大小、MD5；没有足够元数据建立校验记录时，走实际内容验证。验证完成后每个版本单独生成分享，仍保留原有至少 10 秒稳定等待。

网络响应丢失时只核对目标，不立即重复写入，也不把未确认的复制切换成上传。源在任何复制前不可读取时可常规上传；8001/132 等验证错误继续停止相关操作。恢复任务可以沿用此前成功版本，即使源本地目录已删除；复制过程中已验证的目标文件会持久化检查点。

自动测试覆盖同内容异名、差异内容、失效校验记录、分批、取消、异步成功与逐项失败、验证错误、响应丢失后的恢复和跨剧拒绝。端到端模拟在原上传流程后新增版本，断言分片/文件提交次数和内容回读次数均未增加，目标名称正确且另有分享链接。测试不能替代真实账号对服务器复制参数和实际耗时的运行验证。
