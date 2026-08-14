# Microsoft Detours source snapshot

This directory vendors the source files required to statically link Microsoft
Detours into the DSH Git Bash token guard.

- Upstream: https://github.com/microsoft/Detours
- Release: v4.0.1
- Commit: e4bfd6b03e50de46b47abfbd1e46b384f0c5f833
- License: MIT; see LICENSE.md

The parent native/CMakeLists.txt defines this repository's build integration and
hardening flags. The vendored upstream source files are kept separate from the
plugin-specific guard and hook implementations.
