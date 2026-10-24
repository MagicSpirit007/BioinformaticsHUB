# BioinformaticsHUB

[中文版](README.md) · [English](README.en.md)

BioinformaticsHUB 是 coding agent 的生物信息学成果展示与存储应用：接收实际分析网站的原始结果页面、图件和附件，保存来源及核验记录，并集中打开或导出成果。

桌面首页显示任务目录、成果缩略图和保存状态。分析流程由外层 AI 通过 MCP/CLI 组织；应用不提供手动流水线配置、序列输入、AI 解读或报告制作界面。已有执行器仍可供 AI 调用，外部补取得的结果可登记回同一任务。

## 使用

1. 在系统设置确认任务存储目录、浏览器连接和运行环境。Windows 桌面与 WSL 中的 coding agent 共用 Windows 后台。
2. 由 coding agent 使用 [AI 工具接口](docs/ai-tools.md) 完成分析，并通过成果登记接口保存原始网页和附件。
3. 交付时查看分析、图表、网页保存和下载四项状态；未核验或缺失项目会明确显示。
4. 交付默认在同一 Chrome 窗口打开全部已保存 HTML，也可点击“打开全部网页”。在线原站入口另行提供。
5. 导出入口为 `index.html`，包含网页、资源、图件和附件。内部 JSON 与日志保留在任务内部，不充作成果。

完整交付协议、兼容规则及验证命令见 [原始网页交付](docs/delivery.md)。既有执行接口见 [工作流说明](docs/workflows.md)。28 个网站均有适配定义，实际可用性与外部服务限制见 [站点验收](docs/site-acceptance.md)，不能以适配数量代替实测。

## 源码与开发

- `apps/bioinformatics-hub`：React / TypeScript / Vite 成果目录。
- `apps/bioinformatics-hub-desktop/workflow`：共享后台、原生执行、独立交付清单与 MCP/CLI。
- `scripts/workflow`：网站执行、原始页面归档、下载和单窗口交付。

```powershell
cd apps/bioinformatics-hub
npm ci
npm run build
cd ../bioinformatics-hub-desktop
npm ci
npm test
cd ../..
.\.venv-local\Scripts\python.exe -m unittest discover -s tests -v
.\packaging\scripts\build_windows.ps1 -SkipUi
```

运行环境依赖见 `requirements-browser.txt` 与 `packaging/requirements-engine.txt`。轻量安装包不包含 Python、Chrome、分析工具、个人凭据或运行记录。旧任务保留，补充成果不会覆盖原执行历史。

上游：[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)。[第三方声明](packaging/THIRD_PARTY_NOTICES.md)。
