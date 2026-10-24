# Jev 工作流配置与运行（0.6）

## 开始使用

1. 安装 Windows x64 轻量包。它包含 Electron、界面、本地分析脚本和项目内 Jev 源码，不附带 Python、Chrome、MAFFT、IQ-TREE、个人 `.env` 或浏览器资料。
2. 在“环境设置”指定浏览器 Python（≥3.12）和本地分析 Python，可以是两个环境。浏览器环境安装根目录 `requirements-browser.txt`，其中 Browser Harness 固定为 0.1.13。本地环境安装 `packaging/requirements-engine.txt`。
3. 选择已有 Jev `.env`，然后检查依赖、Chrome 和模型连接。设置页只保存文件路径与连接地址。模型连接测试会调用已配置的 API。
4. 先选择本次使用本地工具、网页工具或两者组合，默认不勾选任何方式或分析步骤。再自行添加步骤或选择模板，填写输入、数据库、物种、模型、阈值等参数，检查每个节点的执行方式、输入来源与依赖，启动任务。模板与执行方式冲突时须修改流程，不自动替换或删减分析。可添加全部 28 个目录站点、本地工具或试运行网站，并保存自己的模板。
5. 关闭窗口后应用继续在托盘运行；退出 GUI 也不会停止共享后台任务。CLI/MCP/GUI 接入见 [AI 工具说明](ai-tools.md)。恢复已提交任务优先使用原结果 URL；没有可确认回执时必须核对，不能重新提交。

浏览器操作使用 `scripts/vendor/jev_ultrafast`。本机原 Jev 安装只提供解释器、依赖和外部配置。来源、基线提交和补丁见该目录的 `UPSTREAM.md` 与 `LICENSE`。

## Python 与 Chrome

以下命令使用自行创建的环境；把路径换成实际位置：

```powershell
py -3.13 -m venv .venv-browser
& .\.venv-browser\Scripts\python.exe -m pip install -r requirements-browser.txt
py -3.13 -m venv .venv-local
& .\.venv-local\Scripts\python.exe -m pip install -r packaging\requirements-engine.txt
```

使用独立 Chrome 资料目录启动调试连接。不要指向日常个人浏览器资料：

```powershell
Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\BioHubBrowser' -WindowStyle Hidden
```

在设置页填 `http://127.0.0.1:9222`。网站任务拥有独立浏览器上下文；登录状态不从个人浏览器复制。登录或验证码由“接管浏览器”完成，再恢复节点。Chrome 本身若退出，内存中的隔离上下文会丢失；能否恢复取决于站点的可复开回执，不保证 POST 原页或登录会话跨 Chrome 退出存活。

外部配置支持 `TYPESAFE_API_KEY`、`TYPESAFE_MODEL`、`TYPESAFE_BASE_URL`、`TEXT_MODEL_API_KEY`、`TEXT_MODEL_BASE_URL`、`TEXT_MODEL`、`TEXT_MODEL_REASONING`、`BU_CDP_URL`、`BU_CDP_WS` 以及进程代理。缺失值显示配置错误。凭据只传执行进程，不写入前端、事件或工作包，不修改系统环境变量。

本地分析使用 MAFFT、IQ-TREE 的已有安装；也可在启动应用的进程中设置 `BIOINFORMATICS_HUB_MAFFT`、`BIOINFORMATICS_HUB_IQTREE`。IQ-TREE 模型、bootstrap 和线程数在运行前明确配置。

## 三类模板与输入

- 蛋白表征与注释：输入准备 → 理化性质、疏水性、InterPro 三个分支。
- 比对与系统发育：多序列 FASTA → MAFFT → IQ-TREE → iTOL。输入为明确选择的同源序列集合；应用不自行选择同源命中。
- 结构与口袋：单个 UniProt accession → AlphaFold DB UniProt 单体条目 → PrankWeb。结构来源和 PrankWeb 模型显式配置。需要其他来源时可改为 SWISS-MODEL 并重新连接输入。

输入类型包括单条蛋白/核酸 FASTA、多序列 FASTA、标识符、Newick、PDB/mmCIF。FASTA 与文件由程序原样绑定；模型只决定可观察操作与目标，不能生成序列。网页文本框可能把 CRLF 规范为 LF，验证仅容许这种规范及末尾换行，不容许生物字符改变。文件上传保留原始字节。

自定义网站必须提供网址、目标与输入类型。没有确定性结果校验器的结果保持“待核验”，不能作为自动下游输入。

## 调度与恢复

Electron 主进程持有 `WorkflowDefinition`、`SiteRecipe` 快照、`NodeRun`、`ArtifactRef` 和 `session.json` v2。每个 Python 进程执行一个节点。双方 JSONL 消息包含 requestId；网页提交之前，主进程把提交意图 fsync 到校验和事件日志，确认 ACK 后才允许点击。

默认同时操作两个网站、同一主机一个，本地计算一个。远端等待释放槽位，按 30 秒、60 秒直到 5 分钟退避，默认等待上限 24 小时。主动阶段最多 60 动作、120 模型决策。排队轮询与模型调用分离。

节点状态区分就绪、执行、远端等待、人工、待核验、验证、成功、失败、暂停、取消、上游阻塞。上游失败只阻断依赖分支。暂停在动作边界生效；退出时保存检查点，并停止本地执行进程。取消不会撤销网站上已经运行的计算，界面会记录远端可能继续运行。

`events.jsonl` 是带完整快照和 SHA256 的写前日志；不完整的尾行不会作为事件。`.controller.lock` 防止同一任务被两个控制器执行。`session.json` 损坏时可从完整日志恢复。

若点击是否生效不明，节点进入“待核验”。在实际网站确认后填写原任务结果 URL；只有确认未提交时才能选择“网站尚未提交”。页面打开、模型 DONE、下载按钮、任务列表中的 Completed 均不构成成功证明。

## 产物与工作包

下载先到节点的 `downloads.tmp`，检查格式、完整下载、唯一文件、输入关联、路径范围与 SHA256 后才登记。结构、比对、Newick 等产物还经过解析器校验。下游只接受来自已成功节点的唯一已验证类型，歧义会暂停。

导出在任务目录生成 `10_research_handoff`，包含输入副本、原始文件、结构化结果、流程和参数快照、站点规则快照、证据、简化事件与产物索引。导出前重新验证哈希，不复制外部配置、浏览器能力 ID 或模型凭据。整个目录可以复制给其他研究者；Markdown 不是唯一需要复制的文件。

旧任务可从“查看旧版研究任务”读取与导出。旧文件不原地升级，新任务统一创建 v2。旧浏览器执行代码仅保留用于历史兼容回归，新任务不再走独立 Plant-mPLoc Playwright 路径。

## 验证与当前限制

逐站结果以 [站点验收矩阵](site-acceptance.md) 为准。拥有适配器不代表已实测通过，远端排队、账户条件、网站错误与适配缺口分别列出。首版没有批量样本调度，没有 AI 综合研究解读。通用标记校验尚需逐站补强的站点不会按“全部通过”发布。

可复现实例及公开数据来源见 [tests/fixtures/README.md](../tests/fixtures/README.md)。本地浏览器/恢复夹具不消耗外部模型额度，真实站点实测必须明确使用 `--live`。

```powershell
node --test apps/bioinformatics-hub-desktop/tests/*.test.cjs
& .\.venv-local\Scripts\python.exe -m unittest discover -s tests -v
$env:WORKFLOW_BROWSER_PYTHON='C:\YourJev\.venv\Scripts\python.exe'
$env:WORKFLOW_LOCAL_PYTHON='D:\BioinformaticsHUB\.venv-local\Scripts\python.exe'
$env:BU_CDP_URL='http://127.0.0.1:9222'
node scripts/check_workflow_recovery.cjs
& $env:WORKFLOW_BROWSER_PYTHON scripts/check_workflow_browser.py --chrome-url $env:BU_CDP_URL
& $env:WORKFLOW_BROWSER_PYTHON tests/test_jev_protocol.py -v
```

eggNOG-mapper 当前通过通知邮件发送私有启动链接。运行前需填写邮箱并明确选择通知同意项；收到邮件后在接管阶段打开该链接，再用原任务结果地址恢复。该站未完成邮件激活时不能算作分析完成。STRING 若将同一 accession 映射到多个蛋白，则需人工选择；程序不会静默选择 HBA1 或 HBA2。
