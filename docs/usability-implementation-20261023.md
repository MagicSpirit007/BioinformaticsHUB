# 网页打开、邮件通知与开始菜单修复

2026-10-23。浏览器参数修复已完成；重新构建的 Windows 候选包通过验收，Edge 实际显示 SignalP 结果。当前安装没有替换，历史分析没有重新提交。

## 截图反馈后的修正

此前的 Windows 打开验收只确认进程接受请求，离线内容则在 Electron 中单独检查，未能发现 Edge 地址栏多出的双引号。用户截图暴露了这一验收缺口。实际默认浏览器注册命令为 `msedge.exe --single-argument %1`；原实现逐参数加引号，使 Edge 将原始尾部的引号读入地址。

现改为普通参数传递，移除 `--single-argument` 标记并保留其他注册参数。新增 Windows 测试实际启动参数接收进程，覆盖六种注册命令形式及中文、空格、特殊字符 URL；相关回归共 18 项通过。修复后通过默认浏览器打开已有 SignalP 查看副本，屏幕实测已显示结果表格、曲线图和样式：[Edge 实际页面](../runs/usability-validation-20261023/edge-candidate-fixed.png)。未通过浏览器重新提交分析。

## 可见变化

- 默认进入开始页，可选择网页／本地／组合方式及 28 个网站、8 个本地工具，填写参数与研究对象。选择保留，模式冲突需明确处理。任务说明和 JSON 共用带版本的草稿；复制、保存不启动任务。
- 邮件先询问意愿，再收集邮箱并展示接收网站。CLI/MCP 使用同一提交前检查；不接受绕过确认的旧邮箱参数。当前有证据的 PSIPRED、JPred、CDD 声明可选邮件，eggNOG 声明必填与单独存储同意；未核实的网站标为待核实。邮箱不会成为应用全局默认值。
- 保存网页经系统默认浏览器打开。Windows 读取默认 HTTP 浏览器关联，支持中文及空格路径；所有入口共用同一后台逻辑。新建安全查看副本，保留相对资源并禁止脚本、刷新与表单提交。原存档不改写。
- 每张卡就近显示打开进度与失败重试；“已交给浏览器打开”仅表示系统接受请求。逐项失败不阻止其他页；不再要求 Python、模型或 Chrome 调试端口。
- 结果状态区分已有结果、网站计算、邮件激活、提交待核对、执行失败。补回有效文件不会被旧失败记录遮蔽；原错误仍在详情。PSIPRED 可核对原标签或填写已有作业链接继续，未取得回执时不自动重提。

## 接口

`AnalysisDraft.schemaVersion=1` 是交给助手的选择草稿，须转换成现有流程定义后执行。新增桌面 `copyText` 与 `saveDraft`，只操作剪贴板和用户选择的保存文件。

启动及回答接口新增 `notification`，字段为 `choice`、`email`、`siteIds`、`consents`。不满足条件返回 `needs_choice`，不会先查询序列、提交任务或占用幂等键。网站目录增加 `emailNotification`，结果投影增加 `taskState`。

`openResult` / `resultsOpenAll` 保留 `opened/total/failed`，新增 `mode=system`；无专用 `windowId`。浏览器接受请求不等于完成渲染。重复点击产生的新标签由默认浏览器处理。

## 验收

| 检查 | 结果 |
| --- | --- |
| Windows Node 回归 | 上一轮完整回归 98 项通过；本次浏览器参数修正相关 18 项通过（含新增测试） |
| 项目 Windows Python 回归 | 88 项，86 通过、2 跳过 |
| TypeScript / Vite 构建 | 通过 |
| 候选前端、preload、IPC、后台 | 三种模式、邮件非法／拒绝／必填／条款、复制与 JSON 一致、零启动副作用通过 |
| 真实系统打开 | 浏览器 Python、普通 Python、环境文件及 CDP 配置全部置空，SignalP 原存档副本仍成功交给默认浏览器；单项及全部打开均通过；已在 Edge 中核实文字、表格、图表与样式 |
| 离线渲染与保护 | SignalP 文字、12 项样式表及图片加载通过；脚本／刷新／POST 夹具产生 0 次请求 |
| PSIPRED 超时 | 注入 `Input.dispatchMouseEvent` 超时，无回执保留待核对，恢复及重试不产生第二次提交 |
| 候选运行时 | 前端／后台／引擎指纹匹配，拒绝旧构建，隔离本地流程及导出通过 |
| 安装包内容 | 引擎哈希一致；排除密钥、环境文件、任务及浏览器配置目录 |
| 原证据保护 | 22 个原始证据文件哈希未变 |

界面截图已实际查看，覆盖开始页、PSIPRED 恢复区、窄屏和 SignalP 离线结果。首次隐藏窗口截图存在空白／旧帧，已改用持续绘制窗口重新验收；以下索引均指向最终有效记录。

## 交付与证据

- 候选安装包：`apps/bioinformatics-hub-desktop/release-candidate-usability-20261023/BioinformaticsHUB-0.7.0-win-x64.exe`
- SHA256：`af7d7019cbd87d183f0aca3e8670138d1c1e45f2be875f57019b88c56f06ddcc`
- 构建指纹：`3a223d1095e86b7216ceec72029f8b792ac944ec03b8ed20de60c9068d301508`
- 机器可读索引：[usability-validation-20261023.json](usability-validation-20261023.json)
- 桌面验证：[validation.json](../runs/usability-desktop-1792746676224/validation.json)
- 包内流程：[validation.json](../runs/packaged-repair-validation-1792756940694/validation.json)
- 开始页：[start.png](../runs/usability-desktop-1792746676224/start.png)
- PSIPRED：[psipred.png](../runs/usability-desktop-1792746676224/psipred.png)
- 完整测试日志：`runs/usability-validation-20261023/`

旧 PSIPRED 作业依旧缺少可靠回执，未伪造结果，也未重新提交。邮件验证覆盖选择、绑定、阻止越权填写及激活状态，没有向真实邮箱发送测试邮件；网站实际送达取决于其服务。此次交付保留工作区既有未提交修改，没有提交或推送 Git。
