# 28 站验收矩阵

更新：2026-09-21 03:51 UTC。

严格通过：**20/28**。此版本尚未达到“全部 28 站验收通过”的发布条件。

仅当节点成功、产物非空且 SHA256 复核通过时计入通过；JPred 使用加严后的验证器复核。页面观察、任务排队、模型 DONE 和打开结果链接均不计通过。外部服务与适配问题分开记录，尚不能把所有失败归因于网站。

| 网站 | 分类 | 状态 | 证据 / 阻塞原因 |
|---|---|---|---|
| NCBI ORF Finder | verified | succeeded | Official result markers and input provenance verified |
| NCBI BLASTn | verified | succeeded | Official result markers and input provenance verified |
| NCBI BLASTp | verified | succeeded | Official result markers and input provenance verified |
| NCBI PSI-BLAST | verified | succeeded | Official result markers and input provenance verified |
| InterPro | verified | succeeded | Official result markers and input provenance verified |
| NCBI CDD / CD-Search | verified | succeeded | Official result markers and input provenance verified |
| ScanProsite | verified | succeeded | Official result markers and input provenance verified |
| PSIPRED Workbench | external_or_configuration_block | failed | Worker stopped without a valid result (exit 1) |
| JPred4 | external_or_configuration_block | waiting_human | JPred remote cluster failed: its Slurm job status API returned an error; no resubmission performed |
| Phobius | verified | succeeded | Official result markers and input provenance verified |
| SignalP 6.0 | verified | succeeded | Official result markers and input provenance verified |
| TMHMM 2.0 | verified | succeeded | Official result markers and input provenance verified |
| DeepTMHMM | adapter_or_verification_incomplete | waiting_human | DeepTMHMM has no confirmed task result URL in this checkpoint; reconcile the original job before resuming |
| Plant-mPLoc | verified | succeeded | Official result markers and input provenance verified |
| Cell-PLoc 2.0 | verified | succeeded | Official result markers and input provenance verified |
| DeepLoc 2.1 | verified | succeeded | Official result markers and input provenance verified |
| MusiteDeep | external_or_configuration_block | waiting_human | Website requires login/verification or is unavailable |
| STRING | ambiguous_accession | waiting_human | P69905 matched HBA1 and HBA2; an explicit protein selection and recovery of the original browser session are required |
| UniProtKB / BLAST | adapter_or_verification_incomplete | needs_review | No independently verified BLAST hit table; the earlier help-page result was revoked |
| eggNOG-mapper | external_or_configuration_block | waiting_human | eggNOG sent a private start link to the configured email; open that link and reconcile this node before resuming |
| IUPred3 | verified | succeeded | Official result markers and input provenance verified |
| HMMER phmmer | verified | succeeded | Official result markers and input provenance verified |
| MAFFT Web | verified | succeeded | Official result markers and input provenance verified |
| iTOL | verified | succeeded | Official result markers and input provenance verified |
| ESPript 3 | external_or_configuration_block | needs_review | Jev stopped; independent result verification did not pass |
| AlphaFold DB | verified | succeeded | Official result markers and input provenance verified |
| SWISS-MODEL | verified | succeeded | Official result markers and input provenance verified |
| PrankWeb | verified | succeeded | Official result markers and input provenance verified |

完整节点编号、官方结果 URL、产物哈希和观察摘录见 [机器可读矩阵](acceptance/matrix.json)。原始完整运行记录在工作区 `runs/<runId>`；公开副本隐藏邮箱及 URL 中的访问令牌，矩阵哈希指向本地原始产物。个人配置与浏览器能力 ID 未复制到此报告。

复现：先按 `docs/workflows.md` 配置环境，使用 `tests/fixtures` 的公开数据和 `workflow_cli.cjs acceptance ... --live`。本矩阵不代表账户登录、付费功能或全部参数组合都通过。
