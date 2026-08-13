import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Locale = 'zh' | 'en'

export type Translate = (key: string, params?: Record<string, string | number>) => string

type I18nValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translate
}

const STORAGE_KEY = 'bioinformaticshub.locale'

const messages = {
  zh: {
    // Brand & chrome
    'brand.subtitle': '研究网站整合平台 · 0.4',
    'brand.aria': '返回新建任务',
    'nav.new': '新建',
    'nav.session': '任务',
    'nav.history': '历史',
    'nav.aria': '主导航',
    'conn.desktop': '桌面引擎',
    'conn.browser': '浏览器预览',
    'lang.aria': '切换语言',
    'skip.link': '跳到主要内容',

    // Feedback
    'feedback.eyebrow': 'ATTENTION',
    'feedback.title': '需要处理',
    'feedback.dismiss': '知道了',
    'feedback.close': '关闭提示',

    // Status labels
    'status.queued': '已排队',
    'status.pending': '等待中',
    'status.opening': '正在打开',
    'status.opened_manual': '等待人工操作',
    'status.submitting': '正在自动提交',
    'status.result_ready': '结果已就绪',
    'status.completed_manual': '已人工完成',
    'status.running': '本地运行中',
    'status.completed': '已完成',
    'status.partial': '部分完成',
    'status.ok': '已完成',
    'status.needs_manual': '需要人工继续',
    'status.needs_setup': '需要安装本地工具',
    'status.skipped': '不适用于当前输入',
    'status.failed': '失败',
    'status.cancelled': '已取消',
    'status.unknown': '未知',

    // New session
    'new.eyebrow': 'SITE-FIRST RESEARCH',
    'new.title': '多分析网站整合',
    'new.lead': '整理输入、分批打开网站并保存结果链接',
    'new.input.eyebrow': '01 · INPUT',
    'new.input.title': '研究输入',
    'new.field.geneId': '基因 ID',
    'new.field.required': '（必填）',
    'new.field.geneId.placeholder': '例如 CCA0859S0013',
    'new.field.alias': '别名',
    'new.field.alias.placeholder': '例如 CcAZF2',
    'new.field.inputKind': '输入类型',
    'new.inputKind.auto': '自动识别',
    'new.inputKind.cds': 'CDS',
    'new.inputKind.protein': '蛋白',
    'new.field.fasta': 'FASTA 序列',
    'new.file.choose': '选择 FASTA',
    'new.file.orPaste': '也可直接粘贴完整 FASTA',
    'new.scopeNote':
      'CDS 默认使用标准遗传密码、正向第一阅读框翻译；内部终止或不完整 CDS 会明确警告，不会静默修正。',
    'new.summary.eyebrow': 'CURRENT SELECTION',
    'new.summary.sites': '个研究网站',
    'new.summary.tools': '个本地工具',
    'new.summary.note': '参数型网站每批打开 5 个；自动提交白名单共 1 个。',
    'new.websites.eyebrow': '02 · WEBSITES',
    'new.websites.title': '研究网站',
    'new.websites.selectAll': '全选网站',
    'new.websites.clear': '清空',
    'new.websites.lead': '“仅打开”：用户决定参数与模型；“自动提交”只需在本应用中输入序列即可',
    'new.websites.selectGroup': '选择本组',
    'new.websites.clearGroup': '取消本组',
    'new.local.eyebrow': '03 · LOCAL',
    'new.local.title': '本地工具',
    'new.local.pill': '产物逐卡展示来源',
    'new.custom.eyebrow': '04 · CUSTOM',
    'new.custom.title': '自定义网站',
    'new.custom.manage': '管理自定义网站',
    'new.custom.selectGroup': '选择本组',
    'new.custom.clearGroup': '取消本组',
    'new.custom.empty': '尚未添加自定义网站。点击“管理自定义网站”添加你自己的网址与分类。',
    'new.alignment.title': '多序列 FASTA',
    'new.alignment.hint':
      'IQ-TREE 需要等长比对；未比对序列请同时勾选 MAFFT。iTOL 使用本次 IQ-TREE 生成的树。',
    'new.alignment.choose': '选择文件',
    'new.alignment.none': '尚未选择',
    'new.launch.count': '{count} 项已选择',
    'new.launch.hint': '开始后，人工网站会按批次打开；随时可停止后续批次。',
    'new.launch.cta': '建立研究任务',

    // Custom catalog manager
    'custom.modal.title': '自定义网站与分类',
    'custom.modal.lead': '添加自己的网址并归入分类；它们会像其他网站一样出现在选择区并可加入任务。',
    'custom.modal.close': '关闭',
    'custom.groups.label': '分类',
    'custom.groups.empty': '还没有分类，先新建一个。',
    'custom.group.add': '新建分类',
    'custom.group.name': '分类名称',
    'custom.group.addCta': '添加分类',
    'custom.group.remove': '删除分类',
    'custom.group.removeConfirm': '删除分类「{name}」会同时删除其中的所有网站，确定？',
    'custom.sites.label': '网站',
    'custom.sites.empty': '该分类下还没有网站。',
    'custom.site.add': '添加网站',
    'custom.site.name': '网站名称',
    'custom.site.url': '网址（http/https）',
    'custom.site.note': '备注（可选）',
    'custom.site.addCta': '添加网站',
    'custom.site.save': '保存',
    'custom.site.cancel': '取消',
    'custom.site.remove': '删除网站',
    'custom.site.open': '打开',
    'custom.err.nameRequired': '请填写网站名称。',
    'custom.err.urlRequired': '请填写网址。',
    'custom.err.urlInvalid': '网址必须是完整的 http:// 或 https:// 地址。',
    'custom.err.groupNameRequired': '请填写分类名称。',

    // Session dashboard
    'dash.eyebrow': 'RESEARCH SESSION · {version}',
    'dash.legacyBadge': '旧版记录 · 只读兼容',
    'dash.refresh': '刷新',
    'dash.export': '导出研究工作包',
    'dash.cancel': '停止后续任务',
    'dash.stat.sites': '网站完成',
    'dash.stat.manual': '等待人工',
    'dash.stat.tools': '本地工具',
    'dash.stat.input': '输入识别',
    'dash.warnings': '输入检查提醒',
    'dash.sites.eyebrow': 'WEBSITE TASKS',
    'dash.sites.title': '网站任务',
    'dash.sites.hint': '每张卡保留原网站入口与结果链接',
    'dash.sites.empty': '此任务没有网站项目。',
    'dash.local.eyebrow': 'LOCAL TOOLS',
    'dash.local.title': '本地工具产物',
    'dash.local.pill': '不汇总为结论或统一图廊',
    'dash.local.empty': '此任务没有选择本地工具。',
    'dash.log': '运行日志',

    // Site task card
    'task.open.result': '打开结果页',
    'task.open.entry': '打开输入页',
    'task.open.site': '打开网站',
    'task.entry': '入口',
    'task.record': '记录结果',
    'task.noResultRecord': '已记录：此网站没有可复开的结果链接。',
    'task.resultUrl': '可复开的结果页 URL（可选）',
    'task.resultHelp': '请粘贴提交后地址栏中的结果页；若地址仍是入口，请选择无链接完成。',
    'task.notes': '研究备注（可选）',
    'task.notes.placeholder': '记录所选模型、阈值或需要复核之处',
    'task.saveResult': '保存结果链接并完成',
    'task.saveNoLink': '无可复开链接，标记完成',
    'task.automation': '固定脚本',

    // Local tool card
    'local.stamp': '本地生成',
    'local.provenance': '来源',
    'local.source': '实现来源',
    'local.version': '版本',
    'local.parameters': '参数',
    'local.artifactEmpty': '尚无产物。若状态为“需要安装”，请安装对应本地程序后重试。',
    'local.artifactFallback': '本地产物',
    'local.reveal': '在文件夹中显示',

    // History
    'history.eyebrow': 'ARCHIVE',
    'history.title': '研究记录',
    'history.lead': '0.4 会话按网站任务与本地工具展示；旧版流水线记录保留为只读历史。',
    'history.refresh': '刷新',
    'history.legacy': '旧版记录',
    'history.open': '载入记录',
    'history.empty.title': '还没有研究记录',
    'history.empty.text': '创建第一个研究任务后，它会出现在这里。',
    'history.dateUnknown': '时间未知',

    // Empty states
    'empty.session.title': '尚无当前任务',
    'empty.session.text': '先创建研究任务，再在这里跟踪各网站与本地工具。',
    'empty.session.action': '新建任务',

    // Notices / errors
    'msg.sessionDone': '研究任务已完成当前可自动执行的部分。',
    'msg.sessionCancelled': '已停止打开后续网站。已经打开的浏览器标签会保留。',
    'msg.loadFailed': '无法载入记录：{reason}',
    'msg.exported': '研究工作包已导出：{path}',
    'msg.openFailed': '{name} 打开失败：{reason}',
    'msg.resultSaved': '{name} 的结果链接已保存。',
    'msg.resultNoLink': '{name} 已标记完成：无可复开链接。',
    'msg.copied': '{name} 所需{kind}已复制。',
    'msg.revealFailed': '无法显示本地产物：{reason}',

    // Validation
    'validate.geneIdRequired': '请填写基因 ID。',
    'validate.fastaInvalid': '请提供带有 “>” 标题行的完整 FASTA。',
    'validate.selectAtLeastOne': '请至少选择一个研究网站或本地工具。',
    'validate.alignmentRequired':
      '所选本地比对/建树工具需要独立的多序列 FASTA；iTOL 使用本次 IQ-TREE 生成的树。',

    // Input kind / copy labels
    'inputKind.nucleotide_fasta': '核酸 FASTA',
    'inputKind.protein_fasta': '蛋白 FASTA',
    'inputKind.alignment_fasta': '多序列 FASTA',
    'inputKind.tree': 'Newick 树',
    'inputKind.identifier': '基因 / 蛋白标识',
    'inputKind.structure': '结构文件',
    'copyLabel.identifier': '复制标识',
    'copyLabel.alignment_fasta': '复制多序列 FASTA',
    'copyLabel.tree': '需要树文件',
    'copyLabel.structure': '需要结构文件',
    'copyLabel.nucleotide_fasta': '复制核酸 FASTA',
    'copyLabel.protein_fasta': '复制蛋白 FASTA',

    // Source-unavailable messages
    'source.protein_fasta': '蛋白 FASTA 尚未生成；请等待 CDS 翻译完成或直接提供蛋白 FASTA。',
    'source.alignment_fasta': '尚未提供多序列 FASTA。',
    'source.tree': '该网站需要 Newick 树文件，请从本地 iTOL 数据包中取得。',
    'source.structure': '该网站需要三维结构文件，不能用 FASTA 代替。',
    'source.default': '当前任务没有该网站所需的输入。',

    // Result URL validation
    'result.originInvalid': '结果 URL 来源不属于 {name} 的官方允许范围：{origin}',
    'result.stillEntry':
      '这仍是 {name} 的入口页，不能作为可复开的结果链接。若网站提交后地址未变化，请选择“无可复开链接，标记完成”。',
    'result.httpOnly': '结果链接必须是完整的 http:// 或 https:// 地址',

    // Mode badges
    'mode.auto_submit': '自动提交',
    'mode.open_only': '仅打开',

    // Footer
    'footer.colophon':
      'BioinformaticsHUB 0.4 只组织输入、网站任务、来源明确的本地产物与研究链接；不替代研究者选择模型，也不生成综合科学结论。',
  },

  en: {
    // Brand & chrome
    'brand.subtitle': 'Research Site Integrator · 0.4',
    'brand.aria': 'Back to new session',
    'nav.new': 'New',
    'nav.session': 'Session',
    'nav.history': 'History',
    'nav.aria': 'Primary navigation',
    'conn.desktop': 'Desktop engine',
    'conn.browser': 'Browser preview',
    'lang.aria': 'Switch language',
    'skip.link': 'Skip to main content',

    // Feedback
    'feedback.eyebrow': 'ATTENTION',
    'feedback.title': 'Action needed',
    'feedback.dismiss': 'Got it',
    'feedback.close': 'Dismiss notice',

    // Status labels
    'status.queued': 'Queued',
    'status.pending': 'Pending',
    'status.opening': 'Opening',
    'status.opened_manual': 'Awaiting manual input',
    'status.submitting': 'Auto-submitting',
    'status.result_ready': 'Result ready',
    'status.completed_manual': 'Completed manually',
    'status.running': 'Running locally',
    'status.completed': 'Completed',
    'status.partial': 'Partially complete',
    'status.ok': 'Completed',
    'status.needs_manual': 'Needs manual continuation',
    'status.needs_setup': 'Local tool setup required',
    'status.skipped': 'Not applicable to this input',
    'status.failed': 'Failed',
    'status.cancelled': 'Cancelled',
    'status.unknown': 'Unknown',

    // New session
    'new.eyebrow': 'SITE-FIRST RESEARCH',
    'new.title': 'Multi-site analysis hub',
    'new.lead': 'Organize input, open sites in batches, and save result links',
    'new.input.eyebrow': '01 · INPUT',
    'new.input.title': 'Research input',
    'new.field.geneId': 'Gene ID',
    'new.field.required': '(required)',
    'new.field.geneId.placeholder': 'e.g. CCA0859S0013',
    'new.field.alias': 'Alias',
    'new.field.alias.placeholder': 'e.g. CcAZF2',
    'new.field.inputKind': 'Input type',
    'new.inputKind.auto': 'Auto-detect',
    'new.inputKind.cds': 'CDS',
    'new.inputKind.protein': 'Protein',
    'new.field.fasta': 'FASTA sequence',
    'new.file.choose': 'Choose FASTA',
    'new.file.orPaste': 'or paste a complete FASTA directly',
    'new.scopeNote':
      'CDS uses the standard genetic code and forward frame 1 by default; internal stops or incomplete CDS are flagged explicitly, never silently corrected.',
    'new.summary.eyebrow': 'CURRENT SELECTION',
    'new.summary.sites': 'research sites',
    'new.summary.tools': 'local tools',
    'new.summary.note': 'Parameterized sites open 5 per batch; the auto-submit allow-list holds 1 site.',
    'new.websites.eyebrow': '02 · WEBSITES',
    'new.websites.title': 'Research sites',
    'new.websites.selectAll': 'Select all sites',
    'new.websites.clear': 'Clear',
    'new.websites.lead':
      '“Open only”: you choose parameters and models; “Auto-submit” only needs your sequence in this app',
    'new.websites.selectGroup': 'Select group',
    'new.websites.clearGroup': 'Deselect group',
    'new.local.eyebrow': '03 · LOCAL',
    'new.local.title': 'Local tools',
    'new.local.pill': 'Source shown per artifact',
    'new.custom.eyebrow': '04 · CUSTOM',
    'new.custom.title': 'Custom sites',
    'new.custom.manage': 'Manage custom sites',
    'new.custom.selectGroup': 'Select group',
    'new.custom.clearGroup': 'Deselect group',
    'new.custom.empty':
      'No custom sites yet. Click “Manage custom sites” to add your own URLs and categories.',
    'new.alignment.title': 'Multiple sequence alignment',
    'new.alignment.hint':
      'IQ-TREE requires an equal-length alignment; enable MAFFT for unaligned sequences. iTOL uses the tree produced by this run.',
    'new.alignment.choose': 'Choose file',
    'new.alignment.none': 'Not selected',
    'new.launch.count': '{count} selected',
    'new.launch.hint': 'Manual sites open in batches once started; later batches can be stopped at any time.',
    'new.launch.cta': 'Create research session',

    // Custom catalog manager
    'custom.modal.title': 'Custom sites & categories',
    'custom.modal.lead':
      'Add your own URLs and group them into categories; they appear in the selection area and can join sessions like any other site.',
    'custom.modal.close': 'Close',
    'custom.groups.label': 'Categories',
    'custom.groups.empty': 'No categories yet — create one first.',
    'custom.group.add': 'New category',
    'custom.group.name': 'Category name',
    'custom.group.addCta': 'Add category',
    'custom.group.remove': 'Delete category',
    'custom.group.removeConfirm': 'Deleting category “{name}” also removes all of its sites. Continue?',
    'custom.sites.label': 'Sites',
    'custom.sites.empty': 'No sites in this category yet.',
    'custom.site.add': 'Add site',
    'custom.site.name': 'Site name',
    'custom.site.url': 'URL (http/https)',
    'custom.site.note': 'Note (optional)',
    'custom.site.addCta': 'Add site',
    'custom.site.save': 'Save',
    'custom.site.cancel': 'Cancel',
    'custom.site.remove': 'Delete site',
    'custom.site.open': 'Open',
    'custom.err.nameRequired': 'Please enter a site name.',
    'custom.err.urlRequired': 'Please enter a URL.',
    'custom.err.urlInvalid': 'The URL must be a complete http:// or https:// address.',
    'custom.err.groupNameRequired': 'Please enter a category name.',

    // Session dashboard
    'dash.eyebrow': 'RESEARCH SESSION · {version}',
    'dash.legacyBadge': 'Legacy record · read-only',
    'dash.refresh': 'Refresh',
    'dash.export': 'Export research bundle',
    'dash.cancel': 'Stop remaining tasks',
    'dash.stat.sites': 'Sites done',
    'dash.stat.manual': 'Awaiting manual',
    'dash.stat.tools': 'Local tools',
    'dash.stat.input': 'Input detected',
    'dash.warnings': 'Input warnings',
    'dash.sites.eyebrow': 'WEBSITE TASKS',
    'dash.sites.title': 'Website tasks',
    'dash.sites.hint': 'Each card keeps the original entry and result links',
    'dash.sites.empty': 'This session has no website tasks.',
    'dash.local.eyebrow': 'LOCAL TOOLS',
    'dash.local.title': 'Local tool artifacts',
    'dash.local.pill': 'Not merged into a conclusion or gallery',
    'dash.local.empty': 'No local tools were selected for this session.',
    'dash.log': 'Run log',

    // Site task card
    'task.open.result': 'Open result page',
    'task.open.entry': 'Open input page',
    'task.open.site': 'Open site',
    'task.entry': 'Entry',
    'task.record': 'Record result',
    'task.noResultRecord': 'Recorded: this site has no reopenable result link.',
    'task.resultUrl': 'Reopenable result URL (optional)',
    'task.resultHelp':
      'Paste the result page from the address bar after submission; if the address is still the entry page, choose “no link, mark complete”.',
    'task.notes': 'Research note (optional)',
    'task.notes.placeholder': 'Record chosen models, thresholds, or points to revisit',
    'task.saveResult': 'Save result link & complete',
    'task.saveNoLink': 'No reopenable link, mark complete',
    'task.automation': 'Fixed script',

    // Local tool card
    'local.stamp': 'Generated locally',
    'local.provenance': 'Source',
    'local.source': 'Implementation',
    'local.version': 'Version',
    'local.parameters': 'Parameters',
    'local.artifactEmpty': 'No artifacts yet. If the status is “setup required”, install the tool and retry.',
    'local.artifactFallback': 'Local artifact',
    'local.reveal': 'Show in folder',

    // History
    'history.eyebrow': 'ARCHIVE',
    'history.title': 'Research records',
    'history.lead':
      '0.4 sessions are shown by website tasks and local tools; legacy pipeline records remain as read-only history.',
    'history.refresh': 'Refresh',
    'history.legacy': 'Legacy record',
    'history.open': 'Load record',
    'history.empty.title': 'No research records yet',
    'history.empty.text': 'Create your first research session and it will appear here.',
    'history.dateUnknown': 'Unknown time',

    // Empty states
    'empty.session.title': 'No active session',
    'empty.session.text': 'Create a session first, then track its sites and local tools here.',
    'empty.session.action': 'New session',

    // Notices / errors
    'msg.sessionDone': 'The session finished the parts that can run automatically.',
    'msg.sessionCancelled':
      'Stopped opening further sites. Tabs already opened remain open.',
    'msg.loadFailed': 'Cannot load record: {reason}',
    'msg.exported': 'Research bundle exported: {path}',
    'msg.openFailed': 'Failed to open {name}: {reason}',
    'msg.resultSaved': 'Result link for {name} saved.',
    'msg.resultNoLink': '{name} marked complete: no reopenable link.',
    'msg.copied': 'The {kind} required by {name} was copied.',
    'msg.revealFailed': 'Cannot show local artifact: {reason}',

    // Validation
    'validate.geneIdRequired': 'Please enter a gene ID.',
    'validate.fastaInvalid': 'Please provide a complete FASTA with a “>” header line.',
    'validate.selectAtLeastOne': 'Select at least one research site or local tool.',
    'validate.alignmentRequired':
      'The selected alignment/tree tools require a separate multiple sequence FASTA; iTOL uses the tree produced by this run.',

    // Input kind / copy labels
    'inputKind.nucleotide_fasta': 'Nucleotide FASTA',
    'inputKind.protein_fasta': 'Protein FASTA',
    'inputKind.alignment_fasta': 'Multiple sequence FASTA',
    'inputKind.tree': 'Newick tree',
    'inputKind.identifier': 'Gene / protein ID',
    'inputKind.structure': 'Structure file',
    'copyLabel.identifier': 'Copy identifier',
    'copyLabel.alignment_fasta': 'Copy MSA FASTA',
    'copyLabel.tree': 'Needs tree file',
    'copyLabel.structure': 'Needs structure file',
    'copyLabel.nucleotide_fasta': 'Copy nucleotide FASTA',
    'copyLabel.protein_fasta': 'Copy protein FASTA',

    // Source-unavailable messages
    'source.protein_fasta':
      'Protein FASTA not generated yet; wait for CDS translation or provide a protein FASTA directly.',
    'source.alignment_fasta': 'No multiple sequence FASTA provided yet.',
    'source.tree': 'This site needs a Newick tree file; get it from the local iTOL package.',
    'source.structure': 'This site needs a 3D structure file, which FASTA cannot replace.',
    'source.default': 'This session has no input for the requested site.',

    // Result URL validation
    'result.originInvalid': 'The result URL origin is not allowed for {name}: {origin}',
    'result.stillEntry':
      'This is still the entry page of {name}, so it cannot be reused as a result link. If the address does not change after submission, choose “no link, mark complete”.',
    'result.httpOnly': 'The result link must be a complete http:// or https:// address',

    // Mode badges
    'mode.auto_submit': 'Auto-submit',
    'mode.open_only': 'Open only',

    // Footer
    'footer.colophon':
      'BioinformaticsHUB 0.4 organizes input, website tasks, clearly-sourced local artifacts and research links; it does not choose models for the researcher nor synthesize scientific conclusions.',
  },
} as const

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    /* storage unavailable */
  }
  if (typeof navigator !== 'undefined') {
    const lang = String(navigator.language || '')
    if (lang.toLowerCase().startsWith('zh')) return 'zh'
  }
  return 'en'
}

const I18nContext = createContext<I18nValue | null>(null)

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* storage unavailable */
    }
    // Keep the Electron main process messages in sync for dialogs and errors.
    const bridge = typeof window !== 'undefined' ? window.bioinformaticsHub : undefined
    bridge?.setLocale?.(next)
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])

  const t = useCallback<Translate>(
    (key, params) => {
      const template = (messages[locale] as Record<string, string>)[key]
      if (template == null) return key
      return interpolate(template, params)
    },
    [locale],
  )

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used within an I18nProvider')
  return value
}
