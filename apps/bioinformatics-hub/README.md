# BioinformaticsHUB 0.3

BioinformaticsHUB 是网站优先的研究网站整合平台，不是一站式综合分析器。它负责：

- 规范化 CDS / 蛋白 FASTA，并在需要时由本地引擎翻译 CDS；
- 分批打开需要研究者选择参数的网站；
- 仅对无参数的 Plant-mPLoc 执行固定“粘贴 FASTA → 提交 → 打开结果”脚本；
- 保存各网站最终结果链接与研究备注；
- 运行来源明确的本地工具，并在各自卡片内展示参数与产物；
- 导出不含科学结论的 `研究工作包.md`。

界面不再提供 API / Key / 代理设置，不再生成综合结论、统一证据图廊或 AI 分析长文。

## 开发

```powershell
npm run dev
npm run build
```

Vite 在构建时从唯一目录源 `public/site-catalog.json` 生成静态模块，同时将 JSON 原样复制到 `dist/`，因此 Electron 的 `file://` 页面不依赖 `fetch(file://...)`。

## 前端桥接契约

主要方法：`sessionStart`、`sessionCancel`、`loadSession`、`listSessions`、`openSite`、`saveSiteResult`、`revealArtifact`、`exportResearchBundle`、`pickFasta`、`pickAlignment`。

会话事件：`onSessionUpdate`、`onLog`、`onSessionDone`、`onSessionCancelled`、`onSessionError`。

`sessionStart` 参数：

```ts
{
  fastaText: string
  geneId: string
  alias?: string
  inputKind: 'auto' | 'cds' | 'protein'
  siteIds: string[]
  localToolIds: string[]
  alignmentPath?: string
}
```

网站执行模式只有 `open_only` 与 `auto_submit`。目录加载时会强制校验：`auto_submit` 必须且只能是 `plant_mploc`。
