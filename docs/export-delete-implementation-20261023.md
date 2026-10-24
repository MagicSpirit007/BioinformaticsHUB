# 成果导出修复与历史任务永久删除

> 后续更新：2026-10-24 已将导出改为直接打包并检查文件完整性，不再逐项启动浏览器/Python 核验，同时移除了详情右侧重复的删除入口。当前实现及安装验证见 [直接导出修复记录](direct-export-fix-20261024.md)。以下保留前一轮修复记录。

2026-10-23 完成修复与候选包验证；2026-10-24 已用该候选包覆盖安装到 `D:\BioinformaticsHUB\apps`。版本仍为 0.7.0。旧构建已备份，官家的真实历史成果没有被删除、改写或重新导出。

## 结论

`workflow:results` 超时的直接原因不是导出文件过大，而是后台守护进程在读取成果时同步读取并哈希整个任务目录，阻塞了单线程事件循环；同时桌面客户端把 1 秒存活检查的超时当成致命错误。导出本身在这之前并未被证明失败。

现在成果扫描、哈希、复制和校验全部改为异步；同一次请求只扫描一次；导出在任务锁内构建临时目录，完成后原子发布；后台繁忙时存活检查不再误报。历史记录新增确认后永久删除，删除范围仅限该任务目录，并拒绝运行中、远端等待中或正在导出/核验的任务。

## 复现与根因

在旧构建上对真实任务只读复现（未导出、未删除、未修改文件）：

- 任务 `wf-1792415681013-f2bb07`：1091 个文件，约 226 MB；现有导出目录约 35 MB。
- 单次 `results` 读取耗时 1.26–1.92 秒。
- 同时发起 3 个 `results` 请求时，三个都在约 1.03–1.08 秒后返回 `Background request timed out; the task continues.`。

两个因素叠加：

1. `resultItems` 对每个成果文件执行 `statSync` + `readFileSync` + SHA-256，导出时还会再次扫描并复制；`load` 在 `publicSession` 和 `results` 投影中各扫描一次。扫描期间守护进程无法处理其他 socket 请求。
2. `client.ensure()` 的 1 秒 `ping` 超时被直接抛出，未进入方法请求；因此刷新请求在后台繁忙时立即失败，而不是等待结果。

## 实现

### 异步扫描与单次复用

- 新增 `workflow/integrity.cjs`：流式文件哈希、按 `size/mtime/ctime/ino` 键控的摘要缓存、校验读取与“边复制边哈希”。
- `resultItems` 改为异步：一次请求内每个 artifact/input 只校验一次，并把摘要表传给 `contextFor`、`verifyItems` 和导出复制，避免重复读取。缓存只用于跨 3 秒轮询去重；任何写入都会改变签名，损坏或缺失仍会被发现。
- `publicSession` 不再额外扫描一遍；调度器进度保存也不再触发成果扫描。
- `contextFor`、`verifyAnalysis`、`prepareView`、`resultsRegister` 中的大文件读取/复制改为 `fs/promises` 与流式处理。

### 导出

- 同一任务的导出与其他成果修改通过 `core.withTaskLock` 串行；重复点击导出会返回“正在导出”。
- 导出先在 `deliveries/.export-*` 临时目录构建 `files/`、`index.html` 和 `acceptance.json`，完成后重命名为 `export-<时间>-<修订>`；任一步失败都会删除临时目录，不会留下看似成功的成果目录。
- 保留现有目录格式、离线页面 CSP、`acceptance.json` 核验报告。返回值新增 `gaps`，界面区分“离线核验通过”和“交付仍有缺口”，不宣称全部通过。
- `client.ensure` 将 1 秒存活检查超时视为“服务繁忙但存在”，不再把 `workflow:results` 直接判为失败；后台仍会在处理方法前检查构建/工作区一致性。

### 永久删除

- 新增 `workflow:delete` IPC、`preload.delete`、`WorkflowApi.delete`，参数为任务 ID，成功返回 `{ id }`。
- 后台校验任务目录必须位于当前工作区且为工作区直属普通目录；拒绝符号链接/联接点、越界 ID 与外部路径。
- 运行中、远端等待中、有活动执行句柄或正在导出/核验/登记/归档的任务拒绝删除，并返回“请先停止或等待完成”。
- 删除开始即阻止该任务的新变更；释放闲置调度器与 `.controller.lock`，清理读缓存与摘要缓存、幂等请求指针和重启恢复索引，避免定时器或恢复逻辑重新创建目录。
- 递归删除前先对每个条目做可逆重命名探测；有文件被占用时在删除任何内容前中止并明确报错，关闭占用程序后可重试。
- 仅删除任务目录；其他任务、外部原始输入和已另存到目录外的文件保持不变。

### 界面

- 历史记录每条任务和成果详情都有“删除”；确认框显示任务名称与范围（任务记录/执行历史、保存网页/图表/附件、该目录内导出文件），默认焦点为取消，Esc 取消，中英文同步。
- 导出按钮显示“正在导出…”。刷新失败使用独立提示并保留已加载成果；导出失败单独提示，不覆盖成果状态。
- 成功后显示导出位置和“打开导出目录”；核验不完整时展示具体缺口。
- 删除当前任务后选中下一条；删除最后一条后成果页与历史页都显示空状态。删除成功递增列表代次并记录墓碑 ID，删除前发出的列表/详情响应会被丢弃；服务端 `watched` 索引同时移除该任务。

## 接口

- `workflow:delete` / `workflowHub.delete(id)` → `{ id }`
- `workflow:showExport` / `workflowHub.showExport({ id, directory })`，只允许打开该任务 `deliveries/export-*` 目录
- `export` 返回值增加 `gaps`；`verification` 结构保持 `{ status, items }`

## 验证

全部使用临时任务，未对官家真实历史执行导出或删除。

| 检查 | 结果 |
| --- | --- |
| 桌面 Node 回归 | 108 项通过，0 失败（含新增 9 项导出/删除测试） |
| Python 回归 | 88 项，86 通过，2 项按环境跳过 |
| TypeScript / Vite 构建 | 通过 |
| 大文件导出 | 96 MB 临时任务三次候选运行导出 285–497 ms；查询/状态读取最大 48 ms |
| 并发刷新 | 导出期间 results/load 并发请求无超时；不同任务可同时查询 |
| 重复导出 | 第二次请求被拒绝；成果登记与导出串行 |
| 文件损坏/缺失 | 扫描报告完整性错误，导出拒绝且无发布目录 |
| 核验失败 | 导出返回 `verification.status=partial` 和缺口列表，界面不称全部通过 |
| 临时目录 | 模拟发布失败后无 `.export-*` 残留，也无 `export-*` 目录 |
| 删除取消/成功 | 取消保留文件；成功后只移除目标任务，选中下一条 |
| 最后一条 | 两处列表均显示空状态 |
| 活动任务 | 运行中任务被拒并显示原因，任务保留 |
| 目录越界 | 非法 ID、联接点/符号链接均被拒绝 |
| 文件占用 | 失败前不做部分删除；释放句柄后重试成功（Windows 实测） |
| 过期请求 | 删除前取回的列表响应不会让已删除任务重新出现 |
| 重启 | 守护进程重启和渲染器刷新后均无已删除任务 |
| 外部文件 | 外部输入与目录外文件哈希/内容不变 |
| 候选运行时 | 构建指纹匹配，旧构建被拒，独立本地流程完成，load/results/export 状态一致 |
| 覆盖安装 | 安装器退出码 0；安装后 buildId `a66f…`、UI `index-DKoNEoz8.js`、真实历史 14 个元数据哈希不变 |
| 安装后点击 | 已安装载荷的导出/删除完整点击流程通过；安装后独立本地流程通过 |

## 安装包

- 安装包：`apps/bioinformatics-hub-desktop/release-candidate-export-delete-20261023/BioinformaticsHUB-0.7.0-win-x64.exe`
- SHA256：`1e79e82ab5debe2ac356170e8758b251b29e58b1a9bf6137c10a2f6f572a290c`
- 大小：85,977,367 字节
- 构建指纹：`a66f075e56ea34ba2a11462281f3607a8eaf93da386e9600f8cc013e29cf3db0`
- 组件：backend `9473822cceced8f221051a20bcc40f42a8b70868ac586cac3f5bf6775bb96950`，engine `711975d649a5cb451e2db1e34caa0db3b5bc4b587fadae3b415af050a5ba6100`，UI `3c88a0afb4aeb1da71dca6f1e9ad9764ff318a8af76e8a8807da9acd0bc0a4e0`

## 覆盖安装（2026-10-24）

- 安装位置：`D:\BioinformaticsHUB\apps`；安装器退出码 0。
- 旧构建：`3a223d1095e86b7216ceec72029f8b792ac944ec03b8ed20de60c9068d301508`；安装后：`a66f075e…`。
- 旧构建备份：`runs/install-backup-usability-0.7.0-20261024-120220`（131 个文件，299,038,576 字节）。
- 首次尝试返回码 2：安装根目录同时包含仓库源码子目录 `bioinformatics-hub` 与 `bioinformatics-hub-desktop`，旧卸载器无法删除非空安装根目录。将两个源码目录临时移到同卷 hold 目录后重试成功，`finally` 已原样移回；源码文件数与关键文件均恢复，hold 目录为空。
- 安装后启动：主进程 PID 59272，窗口 `BioinformaticsHUB · 原始分析成果`；后台守护进程 PID 56480，`buildId` 与 manifest 匹配，`dataDir` 为 `%APPDATA%\BioinformaticsHUB`，任务根目录仍为原真实目录。
- 启动后 `list` 返回 5 条真实历史任务；没有执行导出、删除或其他变更。
- 真实历史：5 个任务，14 个 `session.json`/`events.jsonl`/`delivery.json` 哈希与安装前基线一致。
- 安装后验证：[点击流程](../runs/export-delete-desktop-1792815420203/validation.json) · [运行/本地流程](../runs/packaged-repair-validation-1792815458309/validation.json) · [窗口截图](../runs/installed-app-20261024.png) · [安装记录](../runs/install-validation-20261024.json)

## 证据

- 可重跑脚本：`scripts/check_export_delete_desktop.cjs`（传候选/已安装目录路径即可；不传则用源码）
- 安装后点击流程：[validation.json](../runs/export-delete-desktop-1792815420203/validation.json)
- 安装后运行时/本地流程：[validation.json](../runs/packaged-repair-validation-1792815458309/validation.json)
- 候选点击流程：[validation.json](../runs/export-delete-desktop-1792756686313/validation.json)
- 源码点击流程：[validation.json](../runs/export-delete-desktop-1792756593502/validation.json)
- 候选运行时/本地流程：[validation.json](../runs/packaged-repair-validation-1792756791667/validation.json)
- 导出成功界面：[export.png](../runs/export-delete-desktop-1792756686313/export.png)
- 删除确认框：[delete-dialog.png](../runs/export-delete-desktop-1792756686313/delete-dialog.png)
- 活动任务拒绝：[delete-refused.png](../runs/export-delete-desktop-1792756686313/delete-refused.png)
- 删除后空状态：[empty.png](../runs/export-delete-desktop-1792756686313/empty.png)

## 边界

- 清理本轮临时夹具时，两个旧候选的运行时证据目录被一并删除；已用相同的 `release-candidate-repair-20261022` 与 `release-candidate-usability-20261023` 包重跑 `check_packaged_runtime.cjs`，并更新两份旧文档的链接。重跑得到的构建指纹与旧记录一致。
- “打开导出目录”验证到 preload/IPC 收到正确路径并调用 `shell.openPath`；自动化没有在桌面上保持真实资源管理器窗口打开。
- 没有删除、导出或改写任何真实历史成果；真实任务只用于旧构建的只读超时复现。
- 文件占用、目录越界和过期响应使用临时夹具与 Windows 文件锁实测；未在真实历史目录上制造锁冲突。
- 导出仍是单任务操作，没有批量删除或回收站；失败后需要重新点击导出。
- 安装根目录同时存放源码目录，导致旧卸载器首次失败；本次覆盖安装通过临时移出源码完成，未改变该长期布局。
