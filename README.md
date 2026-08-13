# BioinformaticsHUB

> [中文版](./README.md) · [English](./README.en.md)

BioinformaticsHUB 是面向蛋白质与 CDS 研究的**多网站聚合桌面应用**。它负责整理序列、批量打开权威分析网站、在安全时完成最简单的网页代填提交，并把本地工具与外部结果组织成可继续研究的任务记录。

它不再试图在应用内复刻所有网站，也不再调用分析 API、拼装“综合结论”或生成来源不清的图片。

Windows 安装包可从 [GitHub Releases](https://github.com/MagicSpirit007/BioinformaticsHUB/releases) 下载。当前发布为 64 位未签名构建，Windows SmartScreen 可能要求手动确认发布者。

## 产品边界

每个功能明确属于以下三种模式之一：

| 模式 | 行为 |
|---|---|
| `auto_submit` | 应用打开真实网站，用浏览器自动粘贴序列并点击提交，最后保留官方结果页 |
| `open_only` | 应用只打开官方输入页，研究者自行选择模型、参数或处理验证码 |
| `local` | 在捆绑的本地 Python 引擎中运行，并把产物写入当前任务目录 |

当前只有 **Plant-mPLoc** 属于 `auto_submit`。它的网页流程仅包含“粘贴 FASTA → Submit”，脚本使用站点专用定位器，不使用坐标点击。DeepLoc、DeepTMHMM、SignalP、TMHMM、MusiteDeep 等凡含版本、模型、阈值或其他参数的站点均为 `open_only`。

> Plant-mPLoc 当前官方提交页使用 HTTP。BioinformaticsHUB 会在网站卡片中明确标识这一点；只有研究者勾选该网站并开始任务时才会直接提交序列。

## 使用方式

1. 粘贴 FASTA 或选择本地 FASTA 文件。
2. 选择网站和本地工具。
3. 开始任务。
4. BioinformaticsHUB 先准备输入，再按批次打开人工网站；Plant-mPLoc 自动进入官方结果页。
5. 对人工网站，可把最终结果页 URL 粘贴回相应卡片。
6. 从任务页导出 `研究工作包.md`，交给研究者或外挂 AI 继续解读。

人工网站按每批 5 个标签页打开，批内间隔约 750 ms，批间间隔约 4 s，以减轻浏览器和网站压力。应用不会抓取残缺 DOM 冒充分析结果。

## 网站目录

网站清单由 [`apps/bioinformatics-hub/public/site-catalog.json`](./apps/bioinformatics-hub/public/site-catalog.json) 统一维护，前端与 Electron 共同读取；Python 对唯一自动站点另设固定白名单，防止目录改动意外扩大自动提交范围。目录覆盖当前工程已有的网络分析入口，包括：

- 亚细胞定位与膜拓扑：Plant-mPLoc、DeepLoc、Cell-PLoc、DeepTMHMM、TMHMM、SignalP、Phobius。
- 结构与功能注释：InterPro、CDD、ScanProsite、IUPred、PSIPRED、JPred。
- 同源、互作与结构：NCBI BLAST、HMMER、STRING、AlphaFold DB、SWISS-MODEL、PrankWeb。
- 其他研究入口：MusiteDeep、eggNOG-mapper、ORF Finder、ESPript 等。

站点页面、字段或按钮改版后，应先用浏览器视觉确认，再更新该站点脚本和定位器。

## 本地工具

本地工具区与网站区相互独立。目前保留：

- 序列预处理与类型识别；CDS 可翻译为蛋白质。
- 核酸组成、阅读框与密码子统计。
- 蛋白理化性质。
- 疏水性等逐位曲线。
- 本地 MAFFT 多序列比对与本地 WebLogo。
- IQ-TREE 系统发育树。
- iTOL 上传数据包导出。

这些工具**不随安装包打包**，而是由用户在需要时自行安装，应用启动时会自动探测它们是否已就绪：

- Python 解释器与依赖（Biopython、NumPy、Matplotlib、Logomaker、Pillow）；
- MAFFT、IQ-TREE（加入 PATH 即可被识别）；
- Playwright Chromium（仅 Plant-mPLoc 自动提交需要）。

未检测到时应用会优雅降级：本地工具标为 `needs_setup`，Plant-mPLoc 降级为手动打开，网站聚合功能不受影响。安装目录中的 `install_tools.ps1` 可一键安装 Python 依赖与 Chromium，并给出 MAFFT / IQ-TREE 的安装指引。

每项工具独立显示状态、来源和文件路径。BioinformaticsHUB 不把这些产物重新包装成统一结论或“图像证据”画廊。

## 任务目录

开发模式默认写入 `runs/<任务 ID>/`；安装版默认写入 `%APPDATA%\BioinformaticsHUB\runs\<任务 ID>\`。

```text
runs/<id>/
  session.json                         # 任务真相源：输入、网站、本地工具、状态与结果 URL
  00_input/                            # 规范化 FASTA
  01_nucleic/ ... 08_tree/             # 仅已选择的本地工具产物
  09_browser/plant_mploc/              # 自动提交站点的状态记录
  10_research_handoff/
    研究工作包.md                       # 输入事实、选择、官方结果链接、本地产物索引
```

`研究工作包.md` 只整理事实和链接，不预写结论，不包含提示词，也不调用大模型。旧版 `runs/` 保留为历史资料；新应用可标记为 legacy，但不会改写或删除它们。

BioinformaticsHUB 不自动迁移旧版本的用户数据；旧任务仍保留在原目录，可由研究者按需手工归档。

## 开发

### Python 会话引擎

```powershell
pip install -r requirements-pipeline.txt
python -m playwright install chromium

python scripts/session_runner.py `
  --fasta path\to\input.fasta `
  --id DEMO `
  --run-dir runs/DEMO `
  --input-kind auto `
  --local-tools nucleic,physchem,hydrophobicity `
  --auto-sites plant_mploc
```

引擎通过标准输出逐行发送 JSON 事件：`input_ready`、`local_update`、`site_update` 和 `done`。`session.json` 由 Electron 主进程统一持久化。

### React 与 Electron

```powershell
cd apps/bioinformatics-hub
npm run build

cd ..\bioinformatics-hub-desktop
npm test
npm run check
npm run dev
```

## 验收

```powershell
# Python 离线测试
python -m unittest discover -s tests -p "test_*.py"

# UI
cd apps/bioinformatics-hub
npm run build

# Electron
cd ..\bioinformatics-hub-desktop
npm test
npm run check

# 捆绑引擎自检
cd ..\..
packaging\engine\python\python.exe packaging\engine\doctor.py
```

联网网页回归必须显式执行，不能作为默认离线测试的一部分。成功标准是：Plant-mPLoc 到达真实官方结果页；其他网站停留在真实输入页并等待研究者设置参数。

## Windows 打包

```powershell
.\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890
```

生成物位于 `apps/bioinformatics-hub-desktop/release/`，即 NSIS 安装包。完整说明见 [`packaging/README.md`](./packaging/README.md)，第三方工具来源与许可证见 [`packaging/THIRD_PARTY_NOTICES.md`](./packaging/THIRD_PARTY_NOTICES.md)。

公开源码仓库不提交 `tools/` 中的第三方二进制。若要自行构建包含 IQ-TREE 的完整安装包，请先按第三方官方许可将 IQ-TREE 2.3.6 Windows 发行版放到 `tools/iqtree-2.3.6-Windows/`；官方 Release 安装包已包含构建时校验过的本地工具。

## 数据与权限

- `archive/completed-analysis/`、`tools/` 及既有历史资产只读。
- 新任务只写入 `runs/`；应用代码只写入 `scripts/`、`apps/`、`packaging/` 和 `tests/` 等约定区域。
- 不保存 API Key，不调用分析 API 或 LLM HTTP，不写系统级永久代理。
- 未经明确要求不提交或推送 Git。

## 许可证

项目自有代码采用 [MIT License](./LICENSE)，版权所有 © 2026 MagicSpirit007。捆绑或调用的第三方组件仍遵循各自许可证，详见 [`packaging/THIRD_PARTY_NOTICES.md`](./packaging/THIRD_PARTY_NOTICES.md)。
