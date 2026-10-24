# BioHub 修复实施记录：首批

日期：2026-10-22。对应计划：`biohub-repair-plan-20261022.md`。

本轮已经开始代码实现，完成回执恢复、导入验证与状态投影、构建握手的首批改动，并产出独立 Windows 候选包。本记录不代表整个修复计划已经完成。Word／PDF 报告仍暂缓。随后按用户要求，已将验收版本替换到正式发布目录并安装、打开；旧版已备份。安装后验收见 `repair-installed-validation-20261022.json`。

## 已实现

| 范围 | 实际改动 | 验收边界 |
|---|---|---|
| 提交意图与回执 | 点击前记录尝试编号、节点、输入指纹、参数指纹、动作与时间；收到点击返回不再当作已取得回执。观察到作业号或通过结果验证后才解除不确定标记。 | 无回执的中断保持 `needs_reconciliation`，节点显示待核对；不自动重提。 |
| 恢复安全 | 旧作业按已保存的结果地址恢复；拒绝把首页当作恢复地址，拒绝把旧回执接到已改变的输入／参数。恢复同时保留旧字段兼容。 | 本次 PSIPRED 已丢失的作业号仍未找回，不伪造完成状态。 |
| 科学验证 | 从专用脚本抽取 BLAST、InterPro、Musite、HMMER、MAFFT 数据检查，新增引擎拥有的 `resultsValidate`；调用方不能用 `verified: true` 自行认证。 | 未实现的验证器保持未核验。Musite 的稀疏位点文件还必须匹配原节点中绑定输入的下载文件。 |
| 结果状态 | 当前有效结果与原执行历史分开；查询节点可显示补回后的成功状态，同时返回原 `executionStatus`。文件、输入、参数、相关上游与验证器变化使验证失效。 | 不改写原执行失败记录，不因导入而启动调度器。完整的调度依赖迁移仍属于后续工作。 |
| 附件 | 增加站点预期附件清单，登记缺失项；JSON／ZIP 等仍须解析，科学输入关联另行核验。网页缺失不再阻断附件独立核验。 | 尚未声明附件清单的网站显示未核验；缺文件不能退化为不适用。 |
| 导出 | 导出 `acceptance.json` 共用当前结果投影；对导出副本中的附件校验实际副本。 | 网页、图表、分析、附件仍分别给出状态，不互相替代。 |
| 版本握手 | 构建清单记录前端、后台、引擎指纹，以及源码提交和未提交改动；执行请求核对构建、协议、引擎路径及规范工作区路径。 | 旧后台／错误工作区请求在执行前被拒绝。首批在独立目录验收；现已替换正式发布目录并完成真实安装，运行指纹匹配。 |
| 安装目录 | 工作进程禁止写入 Python 字节码缓存。 | 候选包需在实际运行后继续通过发布目录检查。 |
| IQ-TREE | 实际使用的 seed 纳入 `iqtree.json` 参数摘要。 | 其他同源筛选与流程参数化仍未全部迁移。 |

## 三项真实结果导入

通过正式 `resultsRegister → resultsValidate → load/results` 接口完成，未重新提交远端分析：

| 节点 | 原执行状态 | 当前分析结果 | 检查 |
|---|---|---|---|
| BLASTP | failed | verified | 200 个 HSP 查询片段；覆盖全部 260 个查询残基；数据库一致。 |
| InterPro | failed | verified | 完整序列、MD5、15 项匹配及位置范围。 |
| MusiteDeep | needs_review | verified | 原输入绑定下载、124 个候选位置、残基、概率与阈值汇总。 |

原任务 `session.json` 的字节内容在导入前后相同。新增交付注册和验证记录保存在原任务旁的 `delivery.json`，其原件另有备份。原网页与附件状态没有借分析通过自动升级；Musite 无原网页仍为未保存。

证据：`repair-import-validation-20261022.json`。实施前代码基线：`repair-implementation-baseline-20261022.json`。

## 已运行的验收

- Node：91 项通过。
- 项目完整 Windows Python：86 项，84 项通过，2 项跳过。系统 Python 因缺少绘图库未作为最终验收环境。
- 前端 TypeScript／Vite 生产构建通过。
- 实际候选 Electron 后台／引擎：隔离工作区完成本地蛋白制备、理化性质及疏水性流程；检查旧构建拒绝、状态查询、科学复核与导出一致性。
- 实际候选引擎配合独立无头 Chrome：长页 2 倍像素分片、区域截图、Canvas、SVG、iframe 与离线显示通过。
- 本地恢复夹具：输入 6000 个残基，重启控制器并关闭、重启整个测试 Chrome 后恢复原作业；提交计数为 1，其他表单提交为 0，下游节点取得已核验输出。
- 使用现有 Windows CRLF 约定检查差异空白通过。

包内运行与浏览器回归使用本地夹具；没有为此次验收调用新的远端分析或付费模型。具体记录位置和最终候选指纹见 `repair-acceptance-index-20261022.json`。

## 尚未完成

1. 其余补回结果的逐项正式迁移与独立复验；本轮三项通过不能代替全部 23 项的导入验收。
2. HMMER、ESPript 等确定性的 `submit / reconcile / poll / fetch / parse / archive` 完整适配器。目前迁入的是部分验证器与附件要求。
3. 参数化同源筛选节点、完整输入血缘、调度器依赖失效与跨节点恢复。
4. InterPro、SWISS-MODEL、QuickGO、MAFFT 四个真实原网页的缺口修复及逐页离线复验。本地归档夹具通过不代替这四页验收。
5. 完整的历史版本升级／卸载矩阵与桌面界面专项验收。真实安装、启动与原工作区保留核验已经完成，5 个历史任务仍可读取，15 个受保护文件哈希未变；卸载的数据保留尚未专门测试。

PSI-BLAST 的原站 CPU 限制、STRING 的物种支持限制继续保留；不换工具、不换物种来虚增通过数量。

## 接口与复验入口

- 科学验证：`biohub results validate TASK --item-id NODE`。
- 网页／附件：`biohub results verify TASK --item-id NODE`。
- MCP：`biohub_results_validate`；桌面桥接：`resultsValidate`。
- 候选构建：`packaging/scripts/build_windows.ps1 -OutputDir release-candidate-repair-20261022`。
- 包内容检查：`python scripts/check_release.py --release-dir apps/bioinformatics-hub-desktop/release-candidate-repair-20261022`。
- 实际包运行：以候选 Electron 的 Node 模式运行 `scripts/check_packaged_runtime.cjs <win-unpacked>`。
- 真实 Chrome 归档：`scripts/check_result_archive.py --engine-root <候选 resources/engine> --chrome-url <独立调试地址>`。

代码保留在现有工作区，没有提交或推送 Git。工作区原有的大量未提交改动均予保留。

## 正式替换与安装

2026-10-22，按用户“换掉”的指令执行：

- 正式发布目录：`D:\BioinformaticsHUB\apps\bioinformatics-hub-desktop\release`，已替换为验收包。
- 当前安装目录：`C:\Users\18993\AppData\Local\Programs\BioinformaticsHUB`，实际主窗口已打开。
- 原版本与配置备份：`D:\BioinformaticsHUB\runs\deployment-20261022-1792668468407`。
- 旧源码后台已正常停止；当前后台从安装目录的 `resources/app.asar` 加载，引擎从同目录的 `resources/engine` 加载。
- 运行构建指纹：`9265bae6768f72515f46e03d440d09f4ceb008a22a53bf39589e1ed02a6ca89f`，与验收包匹配。
- 原工作区与 5 个任务保留；15 个受保护的设置、会话、日志和交付文件哈希未变。BLASTP、InterPro、MusiteDeep 当前分析仍为已核验。
