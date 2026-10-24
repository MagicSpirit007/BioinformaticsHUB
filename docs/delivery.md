# 原始网页交付

BioHub 是外层 coding agent 的成果目录与存储器。桌面界面显示任务、成果缩略图、保存状态、原始附件和执行历史；任务创建及分析组织通过 MCP/CLI 完成。开始页允许用户选择执行方式、工具、参数和邮件通知，并复制任务说明或保存 JSON 草稿交给助手。草稿不直接启动分析；应用不提供聊天、科学解读或报告制作界面。

## 交付接口

既有 `run start/status/control` 等执行接口继续可用。新增接口在 MCP、CLI 和桌面桥接中共用同一后台实现：

| MCP | CLI | 桌面桥接 |
| --- | --- | --- |
| `biohub_results_register` | `results register ID --spec FILE` | `resultsRegister(args)` |
| `biohub_results_finalize` | `results finalize ID --spec FILE` | `resultsFinalize(args)` |
| `biohub_results_open_all` | `results open-all ID` | `resultsOpenAll({id})` |

登记文件示例（作为内部工具输入，不是交付成果）：

```json
{
  "itemId": "protparam",
  "name": "ExPASy ProtParam",
  "kind": "website",
  "sourceUrl": "https://web.expasy.org/cgi-bin/protparam/protparam",
  "inputSha256": "<原任务登记的输入摘要>",
  "files": [
    {"path": "D:\\results\\page.html", "relativePath": "page.html", "sha256": "<实际文件摘要>"},
    {"path": "D:\\results\\assets\\style.css", "relativePath": "assets/style.css", "role": "resource"}
  ]
}
```

`itemId` 与原节点相同时合并展示，执行记录保留。`kind` 可为 `website/local/attachment`。`relativePath` 保留页面资源关系，禁止越出导入目录。文件按内容摘要复制到任务的 `delivery/files/`，单次总量上限 256 MiB。空 `files` 可登记缺失或不支持项目，并在 `message` 中解释原因。

文件摘要确认文件完整性，不能证明科学结果正确。接口不接收调用者自报的 `verified`；外部文件的科学核验默认未知。若复用已独立核验成功的原生节点，可提供 `sourceTaskId/sourceNodeId/inputSha256`，后台重新核对源节点、输入指纹及原始文件摘要。导入不会驱动下游执行。

交付示例：

```json
{"expected":[{"id":"protparam","name":"ProtParam"},{"id":"psipred","name":"PSIPRED"}],"open":true}
```

`expected` 应列出用户要求的完整项目清单。未传时沿用上次清单，首次使用全部已知项目。`finalize` 保留交付版本与逐项缺口，默认打开保存的原站 HTML；`open:false` 只登记，不打开窗口。重复点击会再次交给系统浏览器；标签页行为由默认浏览器决定。打开失败会逐项返回，不能把 `opened=0` 说成“全部打开”。

## 展示、保存与导出

结果检查分为分析有效、图表完整、网页保存完整和下载完整。旧版缺少检查信息时显示“未核验”。原生执行成功与完整交付是不同状态；一个任务可以原生执行失败，但后续补齐部分原始页面。

保存的 HTML 通过系统默认浏览器打开安全查看副本，无需浏览器 Python 或 Chrome 调试连接。接口返回系统接受的请求数与逐项失败，不承诺浏览器已加载完成，也不返回专用窗口 ID。副本保留资源布局并阻止脚本与表单提交，原存档及执行会话保持不变。在线原站入口用于显式访问当前网站；过期或 POST 结果以已保存页面为证据。

HTML 以原页面当前 DOM 生成静态存档，保留控件当前值、选项和 SVG；canvas 尽可能在原位置冻结为图片。动态交互、跨域图像及 Shadow DOM 可能仍有限制，必须保留状态说明。Loading、空白 canvas 或缺失可见图片会使图表保存保持不完整。

默认导出返回 `path/index/directory`，入口为 `index.html`。包含原页面、依赖资源、原始图件和附件，排除程序配置、独立 JSON/JSONL、事件日志及提取文字记录。页面依赖的 JSON 资源仍可保留在资源目录。旧交付目录和原任务 JSON 不会被删除或覆盖。

## 工作区与 Windows/WSL

桌面设置显示当前任务存储、配置位置和连接标识，可选择现有任务目录。此选择保存到配置目录的 `workspace.json`，后续桌面、MCP、CLI 共用；显式 `--home/--runs` 仍优先。选择目录不会移动旧任务。CLI 可用 `biohub workspace D:\\Research\\tasks` 选择目录。

Windows 安装版、开发桌面及开发 CLI 默认共用 `%APPDATA%\BioinformaticsHUB` 的配置与工作区选择；显式 `BIOHUB_HOME` 继续隔离配置。已有开发目录 `runs/.biohub` 保留，可用 `--home` 显式访问。

Windows 项目的 WSL 入口通过结构化 stdin 转接 Windows Node/Electron 和同一 Windows 后台，不在 WSL 启动第二个同工作区服务。文件参数在边界转换；生物序列字节不转换。Windows 运行时不可用时明确报错，不静默切换。POSIX 独立开发/测试可显式设置 `BIOHUB_NATIVE_POSIX=1`。

## 验证

```powershell
node --test apps/bioinformatics-hub-desktop/tests/*.test.cjs
.\.venv-local\Scripts\python.exe -m unittest discover -s tests -v
C:\YourBrowserPython\python.exe scripts/check_delivery_browser.py --launch
apps\bioinformatics-hub-desktop\node_modules\electron\dist\electron.exe scripts/check_workflow_desktop.cjs
```

浏览器验收仅访问本机夹具，不调用模型或分析网站。`scripts/reconcile_cca_delivery.cjs` 只把 2026-10-19 的 CCA0737S0009 历史证据登记到交付清单，核对原执行状态摘要未变；`--open` 可通过系统默认浏览器打开离线查看副本。缺失 HTML 的文字/JSON 证据不会转换成假原站网页。
