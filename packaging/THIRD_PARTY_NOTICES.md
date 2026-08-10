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
