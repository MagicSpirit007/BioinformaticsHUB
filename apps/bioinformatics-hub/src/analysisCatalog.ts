export type SiteExecution = 'auto_submit' | 'open_only'

export type SiteInputKind =
  | 'nucleotide_fasta'
  | 'protein_fasta'
  | 'alignment_fasta'
  | 'tree'
  | 'identifier'
  | 'structure'

export type SiteGroupId =
  | 'sequence'
  | 'homology'
  | 'annotation'
  | 'topology'
  | 'localization'
  | 'evolution'
  | 'structure'

export type SiteCatalogEntry = {
  id: string
  name: string
  group: SiteGroupId
  provider: string
  description: string
  entryUrl: string
  resultOrigins?: string[]
  execution: SiteExecution
  inputKind: SiteInputKind
  automationNote?: string
  risk?: string
  /** English localization fields, loaded from the catalog and custom sites. */
  nameEn?: string
  descriptionEn?: string
  riskEn?: string
  /** Marks a user-defined site not present in the built-in catalog. */
  custom?: boolean
}

export type SiteCatalog = {
  schemaVersion: number
  productVersion: string
  sites: SiteCatalogEntry[]
}

export const SITE_GROUPS: Array<{ id: SiteGroupId; label: string; labelEn: string }> = [
  { id: 'sequence', label: '序列与 ORF', labelEn: 'Sequence & ORF' },
  { id: 'homology', label: '同源检索', labelEn: 'Homology search' },
  { id: 'annotation', label: '功能与位点', labelEn: 'Function & sites' },
  { id: 'topology', label: '结构与拓扑', labelEn: 'Structure & topology' },
  { id: 'localization', label: '亚细胞定位', labelEn: 'Subcellular localization' },
  { id: 'evolution', label: '比对与进化', labelEn: 'Alignment & evolution' },
  { id: 'structure', label: '三维结构', labelEn: '3D structure' },
]

export type LocalToolId =
  | 'nucleic'
  | 'physchem'
  | 'hydrophobicity'
  | 'mafft'
  | 'weblogo'
  | 'iqtree'
  | 'itol'

export type LocalToolDefinition = {
  id: LocalToolId
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  provenance: string
  provenanceEn: string
  inputKind: 'sequence' | 'protein' | 'alignment' | 'tree'
  requiresAlignment?: boolean
  dependsOn?: LocalToolId[]
}

export const LOCAL_TOOLS: LocalToolDefinition[] = [
  {
    id: 'nucleic',
    name: '序列统计与六阅读框',
    nameEn: 'Sequence stats & six frames',
    description: '统计碱基、GC、密码子与 RSCU，并检查正反链六个阅读框。',
    descriptionEn: 'Base counts, GC, codons and RSCU, plus all six reading frames.',
    provenance: 'BioinformaticsHUB 本地引擎 · 标准遗传密码表',
    provenanceEn: 'BioinformaticsHUB local engine · standard genetic code',
    inputKind: 'sequence',
  },
  {
    id: 'physchem',
    name: '蛋白理化性质',
    nameEn: 'Protein physicochemical properties',
    description: '计算分子量、理论 pI、GRAVY、稳定性与氨基酸组成。',
    descriptionEn: 'Molecular weight, theoretical pI, GRAVY, stability and composition.',
    provenance: 'BioinformaticsHUB 本地引擎 · ProtParam 等价计算',
    provenanceEn: 'BioinformaticsHUB local engine · ProtParam-equivalent',
    inputKind: 'protein',
  },
  {
    id: 'hydrophobicity',
    name: '疏水性曲线',
    nameEn: 'Hydrophobicity profile',
    description: '按 Kyte–Doolittle 尺度生成逐位点亲疏水性曲线。',
    descriptionEn: 'Per-residue hydrophobicity profile on the Kyte–Doolittle scale.',
    provenance: 'BioinformaticsHUB 本地引擎 · Kyte–Doolittle',
    provenanceEn: 'BioinformaticsHUB local engine · Kyte–Doolittle',
    inputKind: 'protein',
  },
  {
    id: 'mafft',
    name: 'MAFFT 多序列比对',
    nameEn: 'MAFFT multiple sequence alignment',
    description: '使用本机 MAFFT 对独立多序列 FASTA 进行比对。',
    descriptionEn: 'Align a separate multiple sequence FASTA with local MAFFT.',
    provenance: '本地 MAFFT 可执行程序',
    provenanceEn: 'Local MAFFT executable',
    inputKind: 'alignment',
    requiresAlignment: true,
  },
  {
    id: 'weblogo',
    name: 'WebLogo',
    nameEn: 'WebLogo',
    description: '从同一份本地多序列比对生成保守性 sequence logo。',
    descriptionEn: 'Generate a conservation sequence logo from the same local MSA.',
    provenance: 'BioinformaticsHUB 本地引擎 · WebLogo/Logomaker',
    provenanceEn: 'BioinformaticsHUB local engine · WebLogo/Logomaker',
    inputKind: 'alignment',
    requiresAlignment: true,
  },
  {
    id: 'iqtree',
    name: 'IQ-TREE 系统发育树',
    nameEn: 'IQ-TREE phylogenetic tree',
    description: '自动识别核酸或蛋白等长比对并推断最大似然树；若输入尚未比对，请同时启用 MAFFT。',
    descriptionEn: 'Infer a maximum-likelihood tree from an equal-length alignment; enable MAFFT if the input is unaligned.',
    provenance: '本地 IQ-TREE 可执行程序',
    provenanceEn: 'Local IQ-TREE executable',
    inputKind: 'alignment',
    requiresAlignment: true,
  },
  {
    id: 'itol',
    name: 'iTOL 数据包',
    nameEn: 'iTOL data package',
    description: '从本次 IQ-TREE 结果本地导出 Newick 与注释文件，再由用户上传至 iTOL；勾选时会同时启用 IQ-TREE。',
    descriptionEn: 'Export Newick and annotation files from this run for upload to iTOL; enables IQ-TREE automatically.',
    provenance: 'BioinformaticsHUB 本地导出器',
    provenanceEn: 'BioinformaticsHUB local exporter',
    inputKind: 'tree',
    requiresAlignment: true,
    dependsOn: ['iqtree'],
  },
]

export async function loadSiteCatalog(): Promise<SiteCatalog> {
  const catalog = siteCatalogData as SiteCatalog
  if (!Array.isArray(catalog.sites)) throw new Error('网站目录格式无效')

  const automated = catalog.sites.filter((site) => site.execution === 'auto_submit')
  if (automated.length !== 1 || automated[0]?.id !== 'plant_mploc') {
    throw new Error('网站目录安全校验失败：自动提交白名单必须且只能包含 Plant-mPLoc')
  }
  return catalog
}
import siteCatalogData from 'virtual:site-catalog'
