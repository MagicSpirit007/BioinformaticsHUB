0.7 的共享后台、CLI/MCP 和原始结果目录请参阅 [AI 工具说明](../../docs/ai-tools.md)。以下保留历史接口说明。

当前默认进入开始页：选择网页／本地／组合方式、工具、参数和邮件通知，复制任务说明交给助手执行，或保存 JSON 草稿。复制与保存不会启动任务；成果、历史及系统设置仍保留。交付协议见仓库 docs/delivery.md。
# BioinformaticsHUB Desktop 0.5.2

> [中文版](./README.md) · [English](./README.en.md)

Electron 桌面层负责加载 React 任务驾驶舱、校验网站目录、调度系统浏览器、启动 Python 会话引擎，并原子持久化 `session.json`。

## 开发

```powershell
# 终端 1：UI
cd apps/bioinformatics-hub
npm run dev

# 终端 2：Electron
cd ..\bioinformatics-hub-desktop
npm run dev
```

开发态优先使用已构建的 `packaging/engine` 与其中的便携 Python；引擎尚未构建时，才回退到仓库 `scripts/session_runner.py` 与系统 Python。安装版使用 `resources/engine/` 内的同一套便携引擎。

## 正式桥

Renderer 只能通过 context-isolated preload 使用以下功能：

- `sessionStart` / `sessionCancel` / `loadSession` / `listSessions`
- `openSite` / `saveSiteResult`
- `exportResearchBundle`
- `pickFasta` / `pickAlignment`
- `revealArtifact`
- `setLocale`
- `onSessionUpdate` / `onLog` / `onSessionDone` / `onSessionCancelled` / `onSessionError`

Python stdout 必须是 JSONL 事件：`input_ready`、`local_update`、`site_update`、`done`。普通日志只从 stderr 进入日志面板。

## 浏览器与会话

- `open_only` 网站每批 5 个，批内间隔 750 ms，批间间隔 4 s。
- 只有 `plant_mploc` 可进入 Python `auto_submit` 白名单。
- Python 完成不等于所有人工标签已打开；会话在开站调度结束前保持运行中，用户仍可取消后续标签。
- 网站入口和结果 URL 必须属于 `site-catalog.json` 允许的官方 origin。
- 结果页由主进程调用系统浏览器打开，Python 子进程不直接开标签。

## 文件安全

- 新会话只写到开发态仓库 `runs/` 或安装态 `%APPDATA%\BioinformaticsHUB\runs\`。
- FASTA 上限 10 MiB，比对文件上限 25 MiB；比对文件必须经文件选择器导入并复制进当前 run。
- `bioinformatics-hub-artifact:` 只读取 `session.json` 已声明、canonical 路径位于当前 run 内、大小不超过 50 MiB 的 PNG/JPEG/WebP。
- “在文件夹中显示”同样只接受已声明且未越界的产物。
- 旧 run 仅显示 legacy 摘要，不迁移、不删除、不改写。

## 测试与构建

```powershell
npm test
npm run check

# 仓库根目录
.\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890
```

发布与便携引擎说明见 [`packaging/README.md`](../../packaging/README.md)。
