# 任务卡片与交互问题修复

2026-10-24 完成，当前安装版已更新并重启。删除按钮位于任务卡片边框内的右下角，选择任务与删除仍是两个独立按钮，点击删除不会切换任务。成果目录和历史记录使用同一布局。

## 发现并修复的问题

通过真实渲染器与可控 IPC 延迟复现，修复前六项专项检查全部失败，修复后源码、候选及安装版全部通过。

| 问题 | 修复 |
| --- | --- |
| 删除按钮在任务边框外 | 由任务行容器承载边框与选中状态，删除按钮收进卡片右下角；桌面及窄窗口检查通过 |
| 详情读取失败后“重试”只刷新列表 | 按失败来源重试详情读取，失败提示保留至请求成功 |
| 切换任务后旧核验结果覆盖当前成果 | 核验、分析验证、打开操作与详情恢复检查当前任务及工作区代次 |
| 旧任务导出失败提示出现在新任务 | 导出及打开目录的错误仅在原任务仍被选中时显示 |
| 工作区切换保留删除记录及旧列表响应 | 清空旧工作区删除标记和详情状态，使旧请求失效；同编号任务可在新工作区正常出现 |
| 删除确认框 Tab 焦点移到背景 | Tab / Shift+Tab 在对话框按钮间循环，取消后恢复触发按钮焦点 |

## 验证证据

- [修复前复现](../runs/workbench-interactions-1792820789504/validation.json)：六项失败。
- [源码复测](../runs/workbench-interactions-1792820876757/validation.json)、[候选复测](../runs/workbench-interactions-1792820973878/validation.json)、[安装版复测](../runs/workbench-interactions-1792821053778/validation.json)：六项均通过。
- [Windows Node 回归日志](../runs/task-card-node-tests-20261024.log)：111 项通过，0 失败。
- TypeScript / Vite 构建通过。
- [候选导出删除流程](../runs/export-delete-desktop-1792820977263/validation.json)：无 Python / 浏览器条件下，96 MB 临时成果及网页、附件导出 492 ms，并发查询最大 98 ms；删除保护、过期列表、空状态及重启检查通过。
- [应用使用流程](../runs/usability-desktop-1792820975842/validation.json)：工具选择、邮件选项、复制与保存配置、离线成果打开、中英文和窄窗口通过。SignalP 离线页面缺失图片数为 0；未发起网站分析提交，真实来源文件哈希保持不变。
- [新版任务卡片截图](../runs/workbench-interactions-1792821053778/task-card.png)。

测试覆盖上述本地功能及异常交互，未对全部外部分析网站重新提交任务，不将通过这些检查等同于应用不存在其他问题。

## 安装与保全

使用验证过的候选程序载荷更新 `D:\BioinformaticsHUB\apps`，先备份旧程序，保留源码与工作区配置。更新后五个历史任务仍在，3749 个历史文件、配置及关键源码保护项的哈希与更新前一致。

- [安装记录](../runs/task-card-install-20261024.json)、[运行时验证](../runs/task-card-installed-runtime-20261024.json)、[保全基线](../runs/task-card-install-baseline-20261024.json)。
- 备份目录：`runs/task-card-program-backup-20261024-135020`。
- 构建 ID：`1b40c90fe98e99bd10d6bc00b33ebd3702f8e3157645c0c55d19f015775ff6c8`。
- 安装包：`apps/bioinformatics-hub-desktop/release-candidate-task-card-20261024/BioinformaticsHUB-0.7.0-win-x64.exe`。
- 安装包 SHA-256：`586dfbcfc512a608698af65fb84568d6aec367787d2cdc7733ff5e3a5e7dbf54`，85,978,017 字节。
