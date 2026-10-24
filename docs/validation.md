# 0.7 工具与原始网页目录验证

更新：2026-10-17。

- Windows Node：69 项测试通过，涵盖共享接口、只读读取、幂等提交、待确认编号、MCP 协议及旧版兼容。
- Windows Python：63 项测试，61 项通过、2 项跳过（模型协议环境隔离与旧版真实提交）；5 项模型协议故障测试已在浏览器 Python 单独通过。
- 真实跨进程 CLI/MCP：`runs/tooling-smoke-1792229584968/validation.json`。CLI 提交后退出、MCP 读取后断开，本地三个节点仍完成；幂等重试返回同一任务。
- 三个公开序列来源的历史探测：`runs/sequence-source-check/validation.json`。GigaDB 100571、UniProt P69905、NCBI NP_000549.1 均实际取得该库记录。该历史探测使用过现已移除的 `CCA` 前缀路由，不能证明用户输入编号的物种、来源或缺位；后续 GigaDB 探测必须显式指定来源。
- 编号路由修正：Windows Python 的 `test_sequence_archive.py` 在源码及修正版打包引擎中各 15 项通过；覆盖 `CCA` 不选择特定物种或参考库、物种取自实际检索记录、既有 GigaDB 缓存不成为默认来源，以及显式指定来源时的精确匹配、候选和错误处理。测试使用模拟响应，不代表已确认用户编号的真实物种。为避免停止正在使用的 exe，修正版先构建在 `release/routing-fix/`，再同步当前免安装版的解析器和原路径安装包；任务历史保持原状。
- 真实 Chrome 存档：`runs/archive-smoke-1792229871/validation.json`。HTML、CSS、SVG、iframe 断网重开可读；长页保留 2 倍像素并分片；640×480 区域实际生成 1280×960 PNG。canvas 离线限制明确标为部分存档。
- 真实 Chrome 操作回归：`runs/browser-fixture/validation.json`，13 项通过，包含长序列、上传、Shadow DOM、iframe、下载和任务弹窗。
- 真实 Electron：`runs/desktop-smoke/validation.json`，隔离 preload、共享后台本地分析、结果目录、环境页及托盘均通过；截图为该目录的 `results.png`。
- TypeScript 与 Vite 构建通过。Windows 发布包与无窗口 CLI 检查另见 `runs/delivery/release-validation.json` 及 `runs/packaged-tooling/validation.json`。

0.7 不把工具入口覆盖率视为远端分析通过率。以下 0.6 站点验收是原有记录；本轮未重新提交所有站点，服务故障、登录、邮件激活和输入歧义仍按实际状态返回。

---

# 0.6.0 开发验证版交付记录

更新：2026-09-21。此版本完成流水线引擎与桌面接入，三类首批模板均已端到端通过；28 站严格实测当前为 20/28，尚未满足全部站点通过的整体验收条件。逐站状态以 [验收矩阵](site-acceptance.md) 为准。

## 已执行验证

| 验证 | 结果与证据 |
|---|---|
| Electron 主进程与历史兼容 | 62 项测试通过，涵盖依赖图、资源互斥、校验和写前日志、提交不确定性、暂停、取消、控制器锁、产物篡改与路径约束 |
| Python 分析与输入/结果验证 | 51 项中 49 项通过，2 项按设计跳过：旧版 Plant-mPLoc 真实提交，以及本地分析环境未安装浏览器依赖时的模型协议模块 |
| 模型协议故障 | 浏览器 Python 执行 `tests/test_jev_protocol.py`，5 项通过：限流退避、限流耗尽、非瞬态错误、断网、非法概率选择；均使用本地模拟响应 |
| 真 Chrome 浏览器夹具 | 12 项通过：6000 位序列逐字符一致、上传、隐藏上传重置、原生下拉、必填同意项、Shadow DOM、frame、下载、嵌套滚动、超长内容、框架按钮、任务弹窗；见 `runs/browser-fixture/validation.json` |
| 真 Chrome + 独立控制器重启 | `runs/recovery-fixture-1789961017019/validation.json`：实际提交计数为 1，错误表单提交为 0，恢复原任务，验证 Newick 下载并由本地 iTOL 节点消费 |
| 真实 Electron | `runs/desktop-smoke/validation.json`：隔离 preload 加载 28 站和 3 模板，设置页可用，通过 IPC 执行本地三个节点，历史打开产物，关闭隐藏到托盘并重新打开 |
| 前端 | TypeScript 与 Vite 构建通过；实际桌面截图在 `runs/desktop-smoke/workflow.png`、`run.png` |

完整 Python 发现命令可能另显示模型协议模块缺少 httpx 而跳过；该模块已在独立浏览器 Python 中执行通过。默认本地分析环境不要求安装浏览器依赖。

## 模板和工作包

- 蛋白表征与 InterPro：`wf-1789901913427-4e0208` 四个节点完成，包含实际 IPR/PF 注释，工作包位于该任务的 `10_research_handoff`。
- AlphaFold DB → PrankWeb：`wf-1789902514175-5e01af`，实际 P69905 PDB 被下游上传并产生 3 个口袋，已导出工作包。
- MAFFT → IQ-TREE → iTOL：`wf-1789903371835-53218a` 已完成本地比对、树推断与原 iTOL 任务恢复；官方结果标记、输入来源和树叶名称均通过严格校验，整条模板通过。

## 仍需完成

- eggNOG-mapper：已向指定邮箱发送私有启动链接，等待邮件激活；邮箱未写入产品默认配置或公开报告。
- STRING：公开 P69905 查询映射到 HBA1/HBA2，需明确选择，不能自动猜测。
- UniProt：已撤销帮助页误判；新验证仍未取得符合要求的具体 BLAST 命中表。
- DeepTMHMM：提交后文件入口返回过 Page not found；浏览器退出后的原任务恢复尚待核对。
- JPred：官方任务状态 API 返回 Slurm 集群错误；未重复提交。
- PSIPRED、ESPript、MusiteDeep：保留空响应、不可用或验证未通过记录，不能视为分析完成。

## 安装与交付边界

轻量 NSIS x64 包包含 Electron、界面和项目内 Jev/Python 源码。依赖本机 Python、Chrome、MAFFT、IQ-TREE；不带个人配置、虚拟环境、浏览器资料或运行目录。当前没有代码签名。

已构建 NSIS 安装器，并验证暂存引擎、真实 Electron 启动、IPC 与托盘。尚未在全新 Windows 虚拟机完成安装/卸载验证，不能将这些检查等同于干净系统安装验收。

源码中的既有 `CHANGELOG.md`、`CHANGELOG.en.md` 未提交删除保持原状。未自动提交或推送 Git。
