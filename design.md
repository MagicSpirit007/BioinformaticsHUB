# Design — BioinformaticsHUB

BioinformaticsHUB 的锁定设计系统。应用页面与运行状态共享同一套纸张、字体、玻璃层级和动效规则。

## Genre

Editorial workbench：档案式技术排版，不做营销落地页。

## Macrostructure family

- 应用页：Workbench，工具选择为 F3 规格表，执行阶段采用 F4 步骤序列。
- 结果页：Workbench 的数据摘要变体，优先表格、定义列表和状态行。
- 导航：N9 边缘式导航的应用变体；品牌在左，必要工作区入口在右。
- 收尾：Ft4 简短题记，说明运行边界与数据去向。

## Theme

- Paper：暖灰旧纸 `oklch(94% 0.016 78)`。
- Ink：带棕调的碳黑 `oklch(20% 0.014 55)`。
- Accent：氧化琥珀 `oklch(52% 0.13 50)`，只用于选择、焦点和主动作。
- 玻璃只用于浮动导航、运行确认和模态层；内容清单直接排在纸面上，禁止玻璃套玻璃。
- 纸纤维、扫描线和轻微斑驳全部使用 CSS 渐变与混合模式，不使用生成图片。

## Typography

- Display：系统可用的古典衬线栈，700，正体；中文优先宋体语气。
- Body：Apple / Windows 系统无衬线栈，400。
- Mono：系统等宽栈，仅用于序列、路径和数值。
- 标题紧字距；正文 1.55–1.65 行高；正文最大行宽 65ch。

## Spacing

四点基准，所有页面使用 `apps/bioinformatics-hub/tokens.css` 中的具名间距变量。

## Motion

- 页面进入：短距离淡入，420 ms，指数 ease-out。
- 控件按压：即时 120 ms 缩放/位移反馈。
- 玻璃模态：材质化淡入，300–420 ms，不使用弹跳。
- 减少动态时：仅保留不超过 150 ms 的透明度变化。

## Microinteractions stance

- 成功保持安静；错误给出发生了什么以及下一步。
- 焦点环即时出现，不参与动画。
- 所有触达控件至少 44 × 44 CSS px。
- 勾选分析工具立即更新运行摘要，不弹提示。

## CTA voice

- 主动作：深墨色实体按钮＋暖纸文字，标签必须使用具体动词。
- 次动作：透明纸面、细线边框，不使用渐变与发光。

## Per-page allowances

- 应用页不得添加无语义插画或氛围光球。
- 结果图只来自真实分析数据。
- 结构分析与浏览器步骤必须标注耗时和外部依赖。

## What pages MUST share

- BioinformaticsHUB 文字标记、暖灰纸张、氧化琥珀强调色。
- 同一按钮形状、输入高度、焦点反馈与状态语义。
- “实际来源”和“功能等价实现”必须明确区分。

## Exports

- CSS 源：`apps/bioinformatics-hub/tokens.css`。
- 当前工程不使用 Tailwind 或 shadcn；不生成未消费的重复令牌文件。
