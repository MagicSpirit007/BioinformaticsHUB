# 外部 AI 工具入口（0.7）

Codex、Claude Code 负责理解需求，先询问用户本次使用本地分析工具、网页分析工具，还是两者组合，再按用户选择配置分析流程；用户已经明确指定时沿用其选择。不因本地工具已安装、计算更快或模板含有本地节点而替用户决定。Jev 选择网页操作，文字辅助模型只填写未绑定的普通文字字段。序列、编号和已确认参数原样绑定。桌面应用显示原始结果目录。

桌面默认显示开始页，供用户选择工具、填写研究对象说明与参数，并把任务说明复制给助手；复制和保存 JSON 不提交分析。成果目录继续展示原始网页和文件。外部网页与附件使用 `results register` 登记，任务结束调用 `results finalize` 核对完整清单并集中打开保存页面。完整参数、核验边界与工作区选择见 [原始网页交付](delivery.md)。

## CLI

开发入口为 `node scripts/biohub.cjs`。Windows 安装后使用安装目录中的 `biohub.cmd`；它复用 Electron 的 Node，不要求另装 Node，也不启动 GUI。

```powershell
& 'C:\YourInstall\biohub.cmd' catalog
& 'C:\YourInstall\biohub.cmd' doctor
& 'C:\YourInstall\biohub.cmd' resolve P69905
# 仅在用户明确选择本地与网页组合，并确认 protein 模板后执行：
& 'C:\YourInstall\biohub.cmd' run start --execution-mode mixed --identifier P69905 --template protein --idempotency-key my-protein-001
& 'C:\YourInstall\biohub.cmd' run status <task-id>
& 'C:\YourInstall\biohub.cmd' run events <task-id> --after 0 --follow
& 'C:\YourInstall\biohub.cmd' results list <task-id>
& 'C:\YourInstall\biohub.cmd' results open <task-id> --node-id interpro
& 'C:\YourInstall\biohub.cmd' results export <task-id>
```

复杂流程沿用 `WorkflowDefinition`/`inputs` JSON，使用 `run start --spec task.json`，在 JSON 顶层指定用户所选的 `executionMode`（`local` / `web` / `mixed`）。三种模板和全部网站、本地工具及执行方式均在 `catalog` 中。返回值是 `{"apiVersion":1,"result":...}`；错误写 stderr，事件为 JSONL。

未传 `executionMode` 时，返回 `status: "needs_choice"`、`actionRequired: "choose_execution"`，此时没有创建任务、取序列或提交分析。向用户询问后携其选择重新调用 `run start`；此阶段未占用幂等键，可以沿用同一个键。未指定流程或模板时返回 `choose_workflow`，不默认选择蛋白模板。`local` 流程不能包含网站节点，`web` 流程不能包含本地节点；冲突时返回节点编号，须按用户选择重新配置，不自动替换或删除分析。`mixed` 仅在用户允许组合时使用。某项分析缺少对应实现或所选工具不可用时，说明情况并询问下一步，不得擅自改用另一种方式。以上规则同时适用于 MCP。

确认编号继续运行时保留原来的执行方式。旧版待确认任务尚未保存执行方式的，`run answer` 同样返回选择提示；询问用户后使用 `run answer <task-id> --execution-mode <用户选择>` 继续。

`run start` 支持 `identifier`、`species`、`provider`（auto/ncbi/uniprot/gigadb）、`sequenceKind`、已确认的 `sourceUrl`、`sourceSpecies`、`sourceVersion`，或直接提供 `inputs`。返回 `needs_input` 时没有提交网站任务；检查 `resolution.candidates` 和 `actionRequired` 后询问用户。`run answer <task-id> --identifier <confirmed-id>` 在原任务 ID 下继续。网络错误返回 `SOURCE_UNAVAILABLE`，不等同于查无记录。

编号前缀和项目示例都不是物种或数据库来源的证据。`auto` 可按标准 accession 格式查询 UniProt，其他编号在 NCBI 中发现候选；未提供物种时不添加物种过滤。GigaDB 100571 仅在明确指定 `provider=gigadb` 时检索；不得因 `CCA` 前缀自动选择山核桃库。某个库中的相近编号不能证明输入编号属于该库或存在缺位，也不能据此替换输入。没有可靠命中时，由外层 AI 继续核实来源或向用户索取必要信息。公开参考库缓存为 SQLite 索引，优先 CDS/蛋白库，不下载整个基因组。

## MCP stdio

开发启动命令：`node D:\BioinformaticsHUB\scripts\biohub.cjs mcp`。安装版：`C:\YourInstall\biohub.cmd mcp`。stdout 仅传 MCP 协议；断开连接不会取消后台任务。

Codex 配置示例（替换实际安装路径）：

```toml
[mcp_servers.bioinformatics_hub]
command = "C:\\YourInstall\\BioinformaticsHUB.exe"
args = ["C:\\YourInstall\\resources\\app.asar\\workflow\\entry.cjs", "mcp"]
[mcp_servers.bioinformatics_hub.env]
ELECTRON_RUN_AS_NODE = "1"
```

Claude Code 项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "bioinformatics_hub": {
      "command": "C:\\YourInstall\\BioinformaticsHUB.exe",
      "args": ["C:\\YourInstall\\resources\\app.asar\\workflow\\entry.cjs", "mcp"],
      "env": {"ELECTRON_RUN_AS_NODE": "1"}
    }
  }
}
```

开发时两类客户端都可使用命令 `node`、参数 `[绝对路径/scripts/biohub.cjs, mcp]`。无需通过 cmd 拼接路径。工具名以 `biohub_` 开头，覆盖 catalog、doctor、resolve、run_start/list/status/events/control/answer、results_list/register/finalize/open_all/open/reopen/archive/capture/export。只读状态查询不恢复或改写任务。

## 后台与环境

三个入口共用按数据目录单实例运行的后台。Windows 用命名管道，POSIX 开发态用 Unix socket。

- Windows 安装版、开发桌面及 CLI 共用配置：`%APPDATA%\BioinformaticsHUB`；任务默认其 `runs/`，选择工作区后共用所选目录。POSIX 独立开发配置仍为 `runs/.biohub`。
- 安装配置：`%APPDATA%\BioinformaticsHUB`；任务：其 `runs/`。
- `BIOHUB_HOME` 或 `--home` 修改配置目录；`BIOINFORMATICS_HUB_RUNS` 或 `--runs` 修改任务目录。所有客户端应一致。
- `service status` 查看后台；`service stop` 保存检查点并停止后台。关闭 GUI、CLI 或 MCP 不停止任务。
- 仅恢复该后台登记的活动任务，不在首次启动时自动恢复全部旧任务；提交不确定的节点仍须核对回执。

`settings --spec settings.json` 配置已有 Python、Jev 环境文件路径和 Chrome 调试地址。凭据保留在外部配置，不写入任务或工作包。`doctor` 分开报告 Jev 与可选文字辅助模型配置，不实际调用模型；显式 `modelCheck` 会调用模型。

## 网页存档与高清截图

结果目录默认通过系统默认浏览器打开原站 HTML 的安全离线副本，无需浏览器 Python 或 Chrome 调试连接；`results open --online true` 可显式激活原在线标签。`results reopen` 是显式重开官方 URL，绝不重新提交分析。

结果验证成功后保存：

- `page.html` 与 `assets/`：从实际 Chrome 页面归档解析的离线页面和资源；不改写科学内容。
- `page.mhtml`：Chrome 原生归档。
- `page.png` 或 `page-001.png` 等：默认 2 倍像素的无损 PNG，长页分片而不缩小。
- `archive.json`：官方 URL、时间、资源完整性、实际像素尺寸、截图区域和限制。

离线页面不重新执行在线分析脚本。canvas 尽可能在原位置保存为静态图像；动态交互与 WebGL 仍可能无法离线重放，会标明限制，PNG 保存当时可见内容。分析状态与存档状态分别显示；`results archive` 仅重试保存。

```powershell
& 'C:\YourInstall\biohub.cmd' results capture <task-id> --node-id interpro --scale 2 --clip '{"x":0,"y":0,"width":640,"height":480}'
```

上述区域输出 1280×960 像素。PPI 元数据不能代替真实像素。导出保留原始 PDF/SVG/表格等文件；`index.html` 只作导航，不添加 AI 解读。

## 验证

```powershell
node --test apps/bioinformatics-hub-desktop/tests/*.test.cjs
.\.venv-local\Scripts\python.exe -m unittest discover -s tests -v
node scripts/check_tooling.cjs
C:\YourJev\.venv\Scripts\python.exe scripts/check_result_archive.py --chrome-url http://127.0.0.1:9222
```

`check_tooling.cjs` 在隔离目录验证真实本地分析、独立 CLI 与 MCP。`check_result_archive.py` 在独立 Chrome 上下文打开本机夹具，检查离线 HTML、iframe、SVG、长页及区域截图，不调用模型。真实站点状态仍以验收矩阵为准，暴露接口不代表服务一定可用。

## 开始页草稿与邮件通知

开始页生成 `AnalysisDraft`（`schemaVersion: 1`），含 `executionMode`、`researchInput`、`selectedTools`、`notification` 和 `missingInformation`。它是用户选择清单，不是可直接提交的流程。助手须保持选定工具与参数，补齐输入／依赖，并转换为现有 `WorkflowDefinition`；不能自动新增、移除或替换分析。仅复制／另存不创建任务。

`catalog.recipes[*].emailNotification` 声明邮件能力：`optional`、`required`、`unsupported` 或 `unknown`；`evidence` 指向官方说明或实际站点观察快照。未确认的能力不宣称支持邮件。首次提交前 `run start` 和 `run answer` 检查通知选择，缺项返回 `needs_choice`，不会查询序列、创建可执行任务或占用幂等键。无支持邮件的网站时无需填写；新发现必填邮箱时由助手询问，不自行猜测。

选择接收时，在启动参数传入：

```json
{"notification":{"choice":"send","email":"user@example.org","siteIds":["jpred","psipred"],"consents":{}}}
```

明确不接收：`{"notification":{"choice":"decline"}}`。只有 `siteIds` 中已选且支持邮件的网站会收到地址。eggNOG 必须提供邮箱及 `consents.eggnog: true`，确认网站存储邮箱条款；拒绝时须由用户修改选择，不静默跳过。CLI 可通过 `--spec`、`--json` 或 `--notification` 传入对象。旧的 `parameters.email` 不能绕过确认；冲突会返回询问。邮箱不保存为应用默认设置，任务参数和用户主动复制／保存的配置会包含本次邮箱。

`results` 新增 `taskState`：网站计算、邮件激活、提交待核对、执行失败、已有结果与尚无结果分开。填写邮箱不等于邮件已发送。无回执的旧 PSIPRED 任务保持待核对；用原任务／邮件中的实际作业链接执行 `control(reconcile)`，不能直接 retry 重提。

`openResult` / `resultsOpenAll` 保留 `opened`、`total`、`failed`，增加 `mode: "system"`，不返回专用窗口编号。`opened` 仅表示系统接受打开请求，不保证浏览器已完成加载。查看副本放在任务的 `delivery/views/`，保留资源布局、禁止脚本和表单提交，原证据不改写。Windows 使用默认 HTTP 浏览器关联，即使 HTML 默认关联编辑器也不会调用编辑器；关联缺失或系统调用失败会显示可重试错误。
