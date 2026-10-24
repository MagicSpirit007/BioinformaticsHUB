# 直接导出成果与精简删除入口

2026-10-24：修复完成，Windows 候选包和当前安装载荷均已验证，安装位置仍为 `D:\BioinformaticsHUB\apps`，版本为 0.7.0。

## 原因与行为

截图任务 `wf-1792549945863-fd7989` 的既有导出报告显示，网页核验从 12:20:42 至 12:28:04 反复连接不可用的自动化 Chrome（9291 端口）。逐项等待约 30 秒导致累计约 7 分 22 秒等待；最后确实发布了导出目录。

现在“导出成果”只打包保存的网页和附件，并检查文件完整性，不调用浏览器或 Python 核验 worker。文件摘要检查、复制时校验、离线 HTML CSP、任务锁、失败清理及原子发布均保留。“核验保存结果”和“核验分析数据”仍为独立操作。

成果详情右侧的“删除任务”已移除；左侧任务行和历史记录的删除入口、确认框及运行中任务保护仍保留。

## 导出接口

- `export(id)` 参数、输出路径和目录格式保持不变。
- 返回 `verification: { status: 'not_run', items: [] }`；类型仍兼容原来的 `complete`、`partial`。
- `acceptance.json.offlineVerification` 记录本次 `not_run`；`previousVerification: { scope: 'saved_results', items: [...] }` 只保存仍匹配当前成果指纹且完整性有效的旧核验记录，包括原核验时间。它不代表导出副本经过了新一轮显示核验。
- 界面明确提示“成果已导出，本次未重新核验网页显示”，保留导出位置、打开目录和交付缺口。损坏或丢失的登记成果文件仍导致导出失败。

## 验证

| 检查 | 结果 |
| --- | --- |
| Windows Node 桌面回归 | 111 项通过，0 失败；其中导出/删除专项 12 项 |
| TypeScript / Vite | 构建通过 |
| 不依赖核验运行环境 | worker 调用次数为 0；候选及安装版均使用空 Python 配置与不可用浏览器地址导出网页和附件 |
| 旧核验与缺口 | 匹配记录和原时间保留，过期指纹排除，本次状态为 `not_run` |
| 失败路径 | 文件损坏/缺失、复制失败、发布失败均拒绝或清理，无成功目录残留 |
| 候选包点击 | 96 MB 文件、两份网页和 TSV 导出 431 ms；并发查询最大 42 ms |
| 安装版点击 | 同类临时任务导出 309 ms；并发查询最大 34 ms |
| 删除与刷新 | 单一入口、取消、运行中拒绝、删除后选中下一条、过期响应隔离及重启后空列表通过 |
| 候选运行时 | 构建指纹匹配、旧构建拒绝、本地分析及导出状态一致 |

导出耗时来自临时夹具，不代表所有真实任务。真实历史未重新导出或删除。“打开导出目录”自动验收到正确路径传入 `shell.openPath`；未自动核验真实资源管理器窗口内容。

证据：[桌面回归日志](../runs/direct-export-node-tests-20261024.log)、[候选点击](../runs/export-delete-desktop-1792817211992/validation.json)、[候选运行时](../runs/packaged-repair-validation-1792817213109/validation.json)、[安装版点击](../runs/export-delete-desktop-1792817383320/validation.json)、[安装版界面](../runs/export-delete-desktop-1792817383320/export.png)。

首次候选点击测试准备时使用了不存在的 Python 路径，被正常的设置校验拒绝；改用合法的空 Python 配置后，完整流程通过。

## 安装与保全

本次使用已验证候选载荷更新当前安装目录，备份后替换程序 EXE、`app.asar`、构建 manifest 和 UI 目录；没有调用卸载器，也没有移动源码目录。后台先停止，更新后重启。

- 构建 ID：`16471d7d3634aed37a22e64c36551e0b3b00439df209c5f3432944c22dfa531c`。
- 旧程序备份：`runs/direct-export-program-backup-20261024-124910`。
- 更新前后核对五个真实任务及配置、关键源码文件，共 3748 个文件哈希。
- [更新记录](../runs/direct-export-install-20261024.json)、[保全基线](../runs/direct-export-install-baseline-20261024.json)、[安装版运行时](../runs/direct-export-installed-runtime-20261024.json)。

Windows 安装包：`apps/bioinformatics-hub-desktop/release-candidate-direct-export-20261024/BioinformaticsHUB-0.7.0-win-x64.exe`，85,977,607 字节，SHA-256：`d599d5fc424bdceb3f8e15829a3ba8d4f41c686c42af3e64266e7534565e3ece`。安装包已生成，打包载荷已验证；本轮当前安装版采用上述载荷更新方式。
