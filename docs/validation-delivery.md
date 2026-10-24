# 原始网页交付改造验收

验收日期：2026-10-20（Asia/Shanghai）。

## 实现与运行验证

- 桌面已移除手动流程、FASTA 输入、模板编辑、节点添加和旧界面入口；保留目录、缩略图、文件、状态和历史。
- MCP、CLI、桌面共享成果登记、交付核对和批量打开实现。补充成果写独立清单，原生执行记录保持不变。
- Windows 安装版、开发桌面、开发 CLI 默认共用应用配置；WSL 转接 Windows 后台。实测两个默认入口返回相同 PID 和任务目录。
- 最终后台回归：86 个测试通过，覆盖新增的导出与缓存行为。完整最终日志见 `runs/delivery-node-tests.txt`。
- Python 本地分析环境：71 个测试，2 个显式跳过，其余通过。跳过项按环境与显式开关跳过。
- 真实 CLI/MCP 联测通过：独立进程、幂等启动、本地节点执行、事件及 index.html 导出。
- 真实 Chrome 夹具通过：动态输入与选项、SVG、canvas、iframe、真实 POST 弹窗接管、断网阅读、关闭单个标签补开、上下文丢失及完整浏览器重启。归档打开没有重复 POST。
- 真实桌面与预加载桥接通过；本次任务界面显示 27 张卡片（26 项分析记录及 1 个外部报告附件），流程构建控件数为 0。
- 大任务持续读取复核：25 轮并发读取目录、状态与成果，最慢 306 ms，末轮 15 ms。未变化的事件日志使用缓存，变化或损坏仍重新校验。

## 本次任务交付

- 26/26 项有明确交付记录；另收存外部 DOCX/PDF 报告附件。
- 20 份去重后的原始 HTML 已实际打开，全部属于同一个 Chrome 窗口，打开失败为 0。
- QuickGO 和原 TMHMM 作业页通过既有 URL 的只读 GET 补存，没有新建或重复提交分析。
- 原生执行状态仍为 needs_attention；交付状态仍为 partial。科学核验、图表、归档及下载没有被合并成一个“成功”。
- 外部导入文件按字节摘要保存；没有独立科学核验证据时仍显示“未核验”。文件完整并不等于科学正确。

| 项目 | HTML 数 | 分析核验 | 归档核验 | 备注 |
|---|---:|---|---|---|
| 01 · NCBI ORF Finder | 1 | 已核验 | 部分保存 | Official result markers and input provenance verified |
| 02 · SMS DNA Stats | 1 | 未核验 | 未核验 | 原站 POST 结果弹窗已保存；历史归档完整性待复核。 |
| 03 · SMS Codon Usage | 1 | 未核验 | 未核验 | 原站 POST 结果弹窗已保存；历史归档完整性待复核。 |
| 04 · NCBI BLASTn | 1 | 未核验 | 未核验 | 保留已确认的 BLASTn 结果；错误输入尝试未登记为成果。 |
| 05 · ExPASy ProtParam | 1 | 未核验 | 未核验 | 补登记原站结果页面及截图。 |
| 06 · ExPASy ProtScale | 1 | 未核验 | 未核验 | 原站曲线和原始坐标保留；未以派生图替换网页。 |
| 07 · DTU TMHMM 2.0 | 1 | 未核验 | 未核验 | 通过已有作业 URL 只读补存原站 HTML、资源和截图；未重新提交。 |
| 08 · DTU SignalP 6.0 | 1 | 未核验 | 未核验 | 补登记原站结果页面；原生节点的导航失败记录保留。 |
| 09 · InterProScan | 1 | 未核验 | 未核验 | 复用同序列历史任务的原站网页与资源；逐文件复核哈希，保留核验来源。 |
| 10 · PSIPRED | 0 | 未核验 | 未保存 | 原提交状态不确定，未取得可核实作业编号与结果；未重复提交。 |
| 11 · SWISS-MODEL | 2 | 未核验 | 未核验 | 补登记原站模型页面、官方质量报告和结构文件。 |
| 12 · Plant-mPLoc | 0 | 未核验 | 未保存 | 历史证据只有文字结果，缺少原始 POST HTML；未重复提交。 |
| 13 · MusiteDeep | 1 | 未核验 | 未核验 | 补登记原站页面与预测下载；页面图表仍须独立核验。 |
| 14 · STRING | 0 | 未核验 | 未保存 | 目标物种未被网站支持；没有该物种的有效网络网页，代理结果不得冒充目标物种结果。 |
| 15 · InterPro / PANTHER GO | 0 | 未核验 | 未保存 | GO 来源为已有 InterPro 注释；没有独立的 PANTHER 原站 HTML。 |
| 16 · QuickGO | 1 | 未核验 | 未核验 | 通过原站术语 URL 只读补存 HTML、资源和截图；原始历史 JSON 仍在内部保留。 |
| 17 · PrankWeb / P2Rank | 1 | 未核验 | 未核验 | 补登记原站口袋结果页面；WebGL 离线交互仍受限制。 |
| 18 · NCBI BLASTp | 1 | 未核验 | 未核验 | 补登记原站 BLASTp 结果与原始 XML。 |
| 19 · PSI-BLAST | 1 | 未核验 | 未核验 | 仅第 1 轮有结果；第 2 轮网站 HTTP 500，未验证收敛。 |
| 20 · HMMER phmmer | 1 | 已核验 | 部分保存 | Official result markers and input provenance verified |
| 21 · 同源筛选与 FASTA 整理 | 0 | 未核验 | 不适用 | 本地序列整理，无独立网页。 |
| 22 · MAFFT | 1 | 未核验 | 未核验 | 保留原服务器页面与比对文件。 |
| 23 · ESPript | 1 | 未核验 | 未核验 | 保留原站结果页及官方图件。 |
| 24 · WebLogo | 1 | 未核验 | 未核验 | 官方 SVG 已保存；历史页面可能仍为输入表单，不能据此认定原站结果页面完整。 |
| 25 · IQ-TREE 2.3.6 | 0 | 已核验 | 不适用 | 独立本地 IQ-TREE 原生任务已完成；通过原始输入指纹和文件哈希关联。 |
| 26 · 树图排版与美化 | 0 | 未核验 | 不适用 | 本地 Matplotlib 排版图，保留为本地产物，不标为分析网站原页面。 |

## 可复核产物

- [交付协议](delivery.md)
- [最终界面截图](../runs/delivery-current-ui.png)
- [后台回归日志](../runs/delivery-node-tests.txt)
- 真实浏览器验证：`runs/delivery-smoke-1792489556/validation.json`（内部测试记录）。
- 桌面夹具验证：`runs/desktop-delivery-smoke-1792488039365/validation.json`（内部测试记录）。
- CLI/MCP 验证：`runs/tooling-smoke-1792488690799/validation.json`（内部测试记录）。
- [最终可浏览成果目录](../runs/cca0737s0009-26items-20261019/tasks/wf-1792415681013-f2bb07/deliveries/export-1792489605372-32/index.html)

历史 Plant-mPLoc 仅保留文字证据，PSIPRED 无可靠作业结果，STRING 对目标物种不支持，PSI-BLAST 后续轮次有外站错误；这些缺口未通过伪造网页、改写原执行记录或自动重提任务来填补。
