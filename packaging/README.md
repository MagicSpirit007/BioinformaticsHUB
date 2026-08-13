# BioinformaticsHUB 0.3 Windows 打包

> [中文版](./README.md) · [English](./README.en.md)

本目录把 React 任务仪表盘、Electron 会话调度层和可移植 Python/Playwright 引擎打成 Windows 安装包与便携版。

## 产物布局

```text
packaging/
  cache/                       # 下载缓存
  engine/                      # bootstrap_engine.ps1 生成
    python/                    # embeddable CPython 与 Python 包
    scripts/                   # session_runner、本地工具及浏览器脚本
    tools/                     # IQ-TREE 与官方 MAFFT Windows 包
    doctor.py
    engine_manifest.json
  playwright-browsers/         # 固定版 Chromium
  requirements-engine.txt
  scripts/
    bootstrap_engine.ps1
    build_windows.ps1
    doctor.py
```

安装后 Electron 的 `resources/` 包含：

```text
resources/
  ui/                          # apps/bioinformatics-hub/dist
  engine/                      # packaging/engine
```

安装版任务默认写到 `%APPDATA%\BioinformaticsHUB\runs\<id>\`；开发模式写到仓库 `runs/<id>/`。

## 构建

在仓库根目录执行：

```powershell
# 完整重建引擎、UI、NSIS 与 portable
.\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890

# 已确认 packaging\engine 为当前 0.3 版本时跳过引擎
.\packaging\scripts\build_windows.ps1 -SkipEngine

# 只构建引擎和 UI，不生成安装包
.\packaging\scripts\build_windows.ps1 -SkipInstaller

# 只重建可移植引擎
.\packaging\scripts\bootstrap_engine.ps1 -Proxy http://127.0.0.1:7890
```

输出：

```text
apps\bioinformatics-hub-desktop\release\
  BioinformaticsHUB-0.3.0-win-x64.exe
  BioinformaticsHUB-0.3.0-portable.exe
  win-unpacked\BioinformaticsHUB.exe
```

## 引擎范围

捆绑引擎包含：

- `scripts/session_runner.py` 会话入口。
- 序列预处理、核酸统计、蛋白理化与疏水曲线所需代码。
- 官方 MAFFT 7.526 Windows 可移植包、WebLogo、IQ-TREE 与 iTOL 导出能力。
- Playwright Python 包与固定版 Chromium，用于 Plant-mPLoc 网页代填提交。

捆绑引擎不包含分析 API 客户端、LLM 客户端、大型第三方数据库或需要研究者自行安装的桌面软件。MAFFT 原包校验 SHA-256 后解压，来源与许可证见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

公开源码仓库不分发 `tools/` 下的第三方二进制。完整自构建若要包含 IQ-TREE，需预先将 IQ-TREE 2.3.6 Windows 发行版放到仓库 `tools/iqtree-2.3.6-Windows/`；缺失时构建会给出警告，运行时相应工具标记为 `needs_setup`。

## 自检

```powershell
packaging\engine\python\python.exe packaging\engine\doctor.py
```

doctor 检查 Python、`session_runner.py`、本地工具模块、Playwright 包、Chromium、MAFFT，以及可选 IQ-TREE。

## 环境变量

| 变量 | 含义 |
|---|---|
| `BIOINFORMATICS_HUB_PYTHON` | 覆盖 Python 可执行文件 |
| `BIOINFORMATICS_HUB_ENGINE` | 覆盖引擎根目录 |
| `BIOINFORMATICS_HUB_RUNS` | 覆盖任务目录根路径 |
| `BIOINFORMATICS_HUB_DEV_URL` | 开发服务器 URL，默认 `http://127.0.0.1:5173` |
| `BIOINFORMATICS_HUB_USE_DIST=1` | 开发模式也加载已构建 UI |
| `BIOINFORMATICS_HUB_DEVTOOLS=1` | 打开开发者工具 |

这些变量只在当前进程读取；构建脚本不会写入系统或用户环境。

## 验收清单

1. `bootstrap_engine.ps1` 完成且 doctor 返回 0。
2. 捆绑 Python 可运行 `scripts/session_runner.py` 并产生 JSONL 事件。
3. React 构建、Electron 测试与静态检查通过。
4. NSIS、portable 和 `win-unpacked` 均生成。
5. 新建任务后可打开人工网站；Plant-mPLoc 可自动代填并进入官方结果页。
6. 任务可保存人工结果 URL，并导出 `10_research_handoff/研究工作包.md`。

## electron-builder 注意事项

未开启 Windows 开发人员模式时，electron-builder 解压 `winCodeSign` 可能因 macOS 符号链接失败。项目已关闭可执行文件签名编辑与身份自动发现；如本机缓存仍损坏，可按现有构建脚本提示清理对应的 `winCodeSign` 缓存后重试。不要因此修改系统级安全设置。

当前 v0.3.0 产物未进行代码签名，Windows SmartScreen 可能显示未知发布者提示。GitHub Release 同时提供 SHA-256 校验文件供下载后核对。
