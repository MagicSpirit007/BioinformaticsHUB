# Changelog

> [中文版](./CHANGELOG.md) · [English](./CHANGELOG.en.md)

## 0.5.1 - 2026-08-13

- 修复 Windows 上 PATH 解析的盘符拆分问题，工具自动探测在跨盘安装（如应用在 C:、Python 在 D:）时不再失败。
- 修复降级模式（未检测到引擎）且未选择任何网站时，会话卡在“运行中”的问题，现在会立即收尾为“部分完成”。
- Chromium 探测改为校验二进制文件真实存在，避免 auto-submit 状态虚报。
- 优化自定义网站管理弹窗：改为视口居中、不透明纸面，支持为网站选择已有分类。
- 修正新建任务页区块编号（自定义网站 03、本地工具 04）。

## 0.5.0 - 2026-08-13

- 安装包不再内置本地工具引擎（Python / MAFFT / IQ-TREE / Playwright Chromium），体积大幅缩小。
- 应用运行时自动探测用户本机的 Python、Python 依赖、MAFFT、IQ-TREE 与 Chromium。
- 引擎缺失时优雅降级：本地工具标记为 `needs_setup`，Plant-mPLoc 降级为手动打开，网站聚合功能不受影响。
- 新增 `install_tools.ps1` 一键安装辅助脚本，并内置引擎检测状态展示。

## 0.4.0 - 2026-08-13

- 新增内置中英语言切换按钮，界面与 Electron 主进程提示全面双语化。
- 新增自定义网址与分类功能，卡片设计与原版一致，可像 `open_only` 网站一样加入研究任务。
- 新增英文版文档（`README.en.md`、`design.en.md`、`CHANGELOG.en.md` 及各应用 README）。

## 0.3.0 - 2026-08-10

- 产品统一更名为 BioinformaticsHUB。
- 前端、Electron 壳、协议、环境变量与安装包标识采用新命名。
- 保留网站聚合、会话管理和独立本地工具能力。
- 提供 Windows x64 NSIS 安装包与 portable 版本。
