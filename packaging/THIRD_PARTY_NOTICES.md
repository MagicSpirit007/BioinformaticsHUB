# Third-party notices

BioinformaticsHUB bundles unmodified command-line tools alongside its own application code. Each tool remains governed by its own license.

## MAFFT 7.526 for Windows

- Project: MAFFT multiple sequence alignment software
- Upstream: https://mafft.cbrc.jp/alignment/software/
- Windows package: `mafft-7.526-win64-signed.zip`
- Package SHA-256: `7C3A508C8512AF04007D68019C6FBD4FF00D891244B58F87EC9AA0E53FBAE8A7`
- License stated by upstream for the Windows package: GNU General Public License (GPL)
- Source and license information: https://mafft.cbrc.jp/alignment/software/source.html

The official archive is copied without modification under `engine/tools/mafft-7.526-win64-signed/`. BioinformaticsHUB invokes its `mafft.bat` launcher as a separate process.

## IQ-TREE

BioinformaticsHUB may also copy the existing IQ-TREE distribution from the repository's read-only `tools/` directory into the portable engine. Consult the license files included with that upstream distribution.
# Jev workflow engine (0.6)

Vendored Jev Ultrafast 0.1.0: https://github.com/browser-use/jev-ultrafast,
commit 1231850a0bf1a0c0341fe408ef1668dbbfdfac46. Copyright (c) 2026 Browser Use,
MIT License. Full license and change record are distributed alongside
`scripts/vendor/jev_ultrafast/`. Browser Harness 0.1.13 is an external MIT-licensed
dependency installed by the user, with its own transitive licenses. httpx is BSD-3-Clause.
The slim installer distributes Jev source, not personal environment files or Python environments.


## Browser Use implementation references

CLI/MCP separation, download-event correlation and region screenshots were reviewed against browser-use/browser-use commit `ccd22fef47a1a36e0c4596fef5db73a5117b9d06` (MIT, copyright 2024 Gregor Zunic). The full browser-use agent framework is not bundled. Browser Harness remains the shared browser transport; Jev provenance and its retained MIT license remain in scripts/vendor/jev_ultrafast.
