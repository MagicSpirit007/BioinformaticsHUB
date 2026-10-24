export type ArtifactKind = 'sequence' | 'protein_fasta' | 'nucleotide_fasta' | 'alignment_fasta' | 'tree' | 'structure' | 'identifier' | 'report'
export type InputBinding = { source: 'input'; key: string } | { source: 'node'; nodeId: string; kind: ArtifactKind }
export type WorkflowNode = {
  id: string; kind: 'site' | 'local'; tool?: string; siteId?: string; custom?: boolean
  entryUrl?: string; goal?: string; inputKind?: ArtifactKind
  input: InputBinding; dependsOn: string[]; parameters: Record<string, string>
  limits?: { maxActions?: number; maxDecisions?: number; waitHours?: number }
}
export type WorkflowDefinition = { id: string; name: string; version: number; nodes: WorkflowNode[] }
export type ExecutionMode = 'local' | 'web' | 'mixed'
export type WorkflowChoice = { status: 'needs_choice'; actionRequired: string; message: string; conflicts?: string[] }
export type WorkflowStartResult = WorkflowSession | WorkflowChoice
export type EmailNotification = { choice: 'send' | 'decline'; email?: string; siteIds?: string[]; consents?: Record<string, boolean> }
export type EmailCapability = { support: 'optional' | 'required' | 'unsupported' | 'unknown'; parameter?: string; fieldPattern?: string; consentParameter?: string; activationRequired?: boolean; evidence?: string; note?: string }
export type AnalysisDraft = { schemaVersion: 1; executionMode: ExecutionMode; researchInput: string; selectedTools: { kind: 'site' | 'local'; id: string; name: string; input: ArtifactKind; parameters: Record<string, string> }[]; notification?: EmailNotification; missingInformation: string[] }
export type Recipe = {
  id: string; name: string; version: number; entryUrl: string; input: ArtifactKind; outputs: ArtifactKind[]
  parameters: { id: string; label: string; required?: boolean; options?: string[]; default?: string }[]
  emailNotification?: EmailCapability; group?: string;
  liveValidation: string; validationNote?: string; allowedHosts: string[]
}
export type ArtifactRef = { path: string; name: string; kind: ArtifactKind; sha256: string; bytes: number; verified: boolean; producer: string; sourceUrl?: string; role?: string }
export type NodeRun = {
  id: string; status: string; message?: string; resultUrl?: string; attempts: number; actions?: number; decisions?: number
  failure?: { stage: string; category: string; details?: { field?: { label?: string; node?: number }; expectedSequenceLength: number; actualSequenceLength: number; firstDifference: number; expectedExcerpt: string; actualExcerpt: string } };
  archive?: { status: string; errors?: string[]; path?: string };
  nextPollAt?: number; artifacts: ArtifactRef[]; canActivate?: boolean; uncertainSubmission?: boolean; submitted?: boolean; remoteMayContinue?: boolean
}
export type WorkflowInputs = Record<string, { kind: ArtifactKind; value: string }>
export type SequenceResolution = { status: string; identifier?: string; kind?: ArtifactKind; fasta?: string; provenance?: Record<string, unknown>; message?: string; actionRequired?: string; candidates?: { identifier: string; species?: string; provider?: string }[] }
export type WorkflowSession = { id: string; schemaVersion: 2; name: string; status: string; executionMode?: ExecutionMode; updatedAt: string; workflow: WorkflowDefinition; nodes: NodeRun[]; resolution?: SequenceResolution }
export type WorkflowSettings = { localPython: string; browserPython: string; envFile: string; chromeUrl: string; workspace?: { id: string; dataDir: string; runsRoot: string; runtime: string } }
export type WorkflowCatalog = { recipes: Record<string, Recipe>; templates: WorkflowDefinition[]; localTools: Record<string, { input: ArtifactKind; outputs: ArtifactKind[]; parameters?: Recipe['parameters'] }> }
export type DeliveryState = { at?: string; version: number; status: string; expected: number; recorded: number; gaps: { itemId: string; message: string }[] }
export type DeliveryItem = { id: string; nodeId?: string; name: string; kind: string; taskState?: string; sourceUrl?: string; capturedAt?: string; message?: string; artifacts: ArtifactRef[]; checks: Record<'analysis' | 'visual' | 'archive' | 'downloads', string>; gaps: string[] }
export type DeliveryResults = { id: string; revision: number; delivery?: DeliveryState; results: DeliveryItem[] }
export type ExportVerification = { status: 'complete' | 'partial' | 'not_run'; items: { itemId: string; issues: string[]; checks: Record<string, string> }[] }
export type ExportResult = { path: string; index?: string; directory: string; items: number; verification: ExportVerification; gaps?: { itemId: string; message: string }[] }
export type DeleteResult = { id: string }
export type OpenPagesResult = { opened: number; total?: number; windowId?: number; mode?: 'system'; message?: string; failed?: { itemId: string; message: string }[] }
export type WorkflowHistory = { id: string; name: string; status: string; updatedAt: string; delivery?: DeliveryState }
export type WorkflowApi = {
  copyText(text: string): Promise<void>
  saveDraft(draft: AnalysisDraft): Promise<{ path?: string; cancelled?: boolean }>
  resolve(args: { identifier: string; species?: string; provider?: string }): Promise<SequenceResolution>
  answer(args: { id: string; identifier: string; species?: string; provider?: string; executionMode?: ExecutionMode; notification?: EmailNotification }): Promise<WorkflowStartResult>
  results(id: string): Promise<DeliveryResults>
  resultsRegister(args: Record<string, unknown>): Promise<DeliveryResults>
  resultsValidate(args: { id: string; itemId?: string }): Promise<DeliveryResults>
  resultsVerify(args: { id: string; itemId?: string }): Promise<{ status: string; items: { itemId: string; issues: string[] }[]; results: DeliveryResults }>
  resultsFinalize(args: { id: string; expected?: { id: string; name?: string }[]; open?: boolean }): Promise<DeliveryResults>
  resultsOpenAll(args: { id: string }): Promise<OpenPagesResult>
  thumbnail(args: { id: string; artifactPath: string }): Promise<{ url: string }>
  openResult(args: { id: string; nodeId?: string; itemId?: string; artifactPath?: string; offline?: boolean; online?: boolean }): Promise<OpenPagesResult | { opened: string | boolean; message?: string }>
  reopenResult(args: { id: string; nodeId: string }): Promise<unknown>
  archive(args: { id: string; nodeId: string }): Promise<unknown>
  capture(args: { id: string; nodeId: string; scale?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<unknown>
  selectWorkspace(): Promise<WorkflowSettings | null>
  catalog(): Promise<WorkflowCatalog>; settings(): Promise<WorkflowSettings>; saveSettings(args: WorkflowSettings): Promise<WorkflowSettings>
  probe(): Promise<{ browser?: { ready: boolean }; local?: { localReady: boolean }; errors: string[] }>; modelCheck(): Promise<{ ok: boolean; message: string }>
  browserCheck(): Promise<{ ok: boolean; message: string }>
  validate(args: { workflow: WorkflowDefinition; inputs: WorkflowInputs }): Promise<{ errors: string[] }>
  start(args: { workflow: WorkflowDefinition; executionMode: ExecutionMode; inputs: WorkflowInputs; name: string; identifier?: string; notification?: EmailNotification }): Promise<WorkflowStartResult>
  list(): Promise<WorkflowHistory[]>; load(id: string): Promise<WorkflowSession>
  clone(id: string): Promise<{ workflow: WorkflowDefinition; inputs: WorkflowInputs; name: string }>
  control(args: { id: string; action: string; nodeId?: string; resultUrl?: string; notSubmitted?: boolean }): Promise<WorkflowSession>
  activate(args: { id: string; nodeId: string }): Promise<unknown>
  pickInput(kind: string): Promise<{ name: string; value: string; kind: ArtifactKind } | null>
  reveal(args: { id: string; artifactPath: string }): Promise<unknown>; export(id: string): Promise<ExportResult>
  delete(id: string): Promise<DeleteResult>
  showExport(args: { id: string; directory: string }): Promise<unknown>
  onUpdate(callback: (session: WorkflowSession) => void): () => void
}
declare global { interface Window { workflowHub?: WorkflowApi } }
