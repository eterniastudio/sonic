# Third-party notices

This notice covers the principal third-party materials used by **Sonic
v0.1.4 for Windows x64**. Sonic's original code is proprietary under the root
[LICENSE](LICENSE). Each third-party component remains governed by its own
license.

The checked-in [`scripts/tool-manifest.json`](scripts/tool-manifest.json) is
authoritative for media-tool versions, immutable artifact URLs, delivery mode,
and SHA-256 values. `package-lock.json` and `src-tauri/Cargo.lock` are
authoritative for JavaScript and Rust package resolution. Official releases
also include CycloneDX SBOMs and generated dependency notices.

## What the Sonic installer contains

The v0.1.4 installer contains these independently launched tools. None is
linked into Sonic's proprietary Rust executable.

| Component | Exact artifact | SHA-256 | License |
| --- | --- | --- | --- |
| yt-dlp 2026.07.04 | [`yt-dlp` zipimport artifact](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp) | `495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd` | Unlicense, with bundled Meriyah code under ISC and Astring code under MIT |
| CPython 3.13.14 embedded runtime | [`python-3.13.14-embed-amd64.zip`](https://www.python.org/ftp/python/3.13.14/python-3.13.14-embed-amd64.zip) | Archive: `90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907`; `python.exe`: `ef8f51028ac5329641985112f8efb1c2d4c47c86b8011ddf7e6fae21e2b4e5a1` | Python Software Foundation License Version 2 and notices reproduced in the archive's `LICENSE.txt` |

Sonic deliberately uses yt-dlp's platform-independent zipimport release, not
the GPL-covered Windows PyInstaller executable. The exact yt-dlp, Meriyah, and
Astring terms are reproduced in
[`licenses/YT-DLP-ZIPIMPORT-LICENSES.txt`](licenses/YT-DLP-ZIPIMPORT-LICENSES.txt).
The complete CPython notice file is installed with Sonic and attached to each
release.

## Optional media engine downloaded by the user

The Sonic installer and GitHub release assets **do not contain FFmpeg,
ffprobe, or Deno**. WAV/MP3 conversion and full YouTube JavaScript support
require these tools. When they are absent, Sonic shows a setup prompt
describing the download. Only after the user chooses **Set up engine** does
Sonic download these pinned upstream archives directly from their GitHub
releases:

| Component | Exact upstream artifact | SHA-256 | License |
| --- | --- | --- | --- |
| FFmpeg and ffprobe `N-125365-g9a01c1cb6a-20260630` | [`ffmpeg-N-125365-g9a01c1cb6a-win64-lgpl.zip`](https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-N-125365-g9a01c1cb6a-win64-lgpl.zip) | Archive: `75cb786fa14299eb1c1cacc2542a15c8da690e551ab41858383dc425c605b8ab`; FFmpeg: `b1ebb2a19864de271d8539cc15934ff31719d184d3cbbcdb50dd16d68aa5db64`; ffprobe: `5036abe12ed18f9048921af6984afeb331de6715afeb30c6bf64194798a4ed02` | LGPL-3.0-or-later; build enables `--enable-version3` and does not enable GPL or nonfree code |
| Deno 2.9.2 | [`deno-x86_64-pc-windows-msvc.zip`](https://github.com/denoland/deno/releases/download/v2.9.2/deno-x86_64-pc-windows-msvc.zip) | Archive: `5fe194d26ac5ef77fcc5288c2c438c7a0465f3b6180440ebf04092714bf2dcdf`; executable: `a5270c2bb75a2ec12fef53185730327267d9e9fe6be6a962c5d1d5a050f93c88` | MIT with third-party components documented by the upstream Deno project |

Sonic verifies both archives and all three executables before use, records
provenance in `engine.json`, preserves the upstream LGPL text beside FFmpeg,
and re-verifies every executable hash before launching it. The local engine is
stored under `%LOCALAPPDATA%\studio.eternia.sonic\media-engine` and is removed
by Sonic's uninstaller through a reparse-aware cleanup script.

Upstream source and build information:

- [BtbN retained month-end build tag `autobuild-2026-06-30-13-34`](https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-06-30-13-34)
- [FFmpeg source commit `9a01c1cb6a`](https://github.com/FFmpeg/FFmpeg/tree/9a01c1cb6a4cf87529fe9898b66ec55c5b032639)
- [FFmpeg licensing explanation](https://github.com/FFmpeg/FFmpeg/blob/9a01c1cb6a4cf87529fe9898b66ec55c5b032639/LICENSE.md)
- [Exact captured build configuration](docs/ffmpeg-build-configuration.txt)
- [FFmpeg legal and compliance guidance](https://ffmpeg.org/legal.html)
- [Deno 2.9.2 source](https://github.com/denoland/deno/tree/v2.9.2)
- [Deno license](https://github.com/denoland/deno/blob/v2.9.2/LICENSE.md)
- [Deno CLI third-party license catalog](https://license.deno.dev/)

Because each transfer is directly from an upstream release rather than a Sonic
release asset, Eternia Studios does not mirror or redistribute those FFmpeg or
Deno object files. Users who choose the optional setup receive the upstream
artifacts and the source/license references recorded by Sonic.

## Code and assets incorporated into Sonic

| Component | Version in v0.1.4 | License | Source |
| --- | --- | --- | --- |
| Tauri runtime and JavaScript API | Rust `tauri` 2.11.5; `@tauri-apps/api` 2.11.1 | MIT or Apache-2.0; Sonic uses the MIT option | [Tauri source](https://github.com/tauri-apps/tauri/tree/tauri-v2.11.5) |
| Tauri first-party plugins | dialog 2.7.1, opener 2.5.4, shell 2.3.5 | MIT or Apache-2.0; Sonic uses the MIT option | [plugins workspace](https://github.com/tauri-apps/plugins-workspace) |
| React and React DOM | 19.2.7 | MIT | [React source](https://github.com/facebook/react/tree/v19.2.7) |
| Phosphor Icons for React | 2.1.10 | MIT | [Phosphor source](https://github.com/phosphor-icons/react/tree/v2.1.10) |
| Barlow Condensed via Fontsource | 5.2.8 | SIL Open Font License 1.1 | [exact Fontsource files](https://github.com/fontsource/font-files/tree/40ecb0c337fd649924783a87783dc2e6639bb6f2/fonts/google/barlow-condensed) |

The native executable also contains crates resolved by
`src-tauri/Cargo.lock`; the webview bundle contains npm runtime packages
resolved by `package-lock.json`. The release's generated Rust and npm notice
files reproduce applicable dependency license and notice text, while the SBOMs
provide the machine-readable package inventory.

The generated Rust notice links every crate to both its exact crates.io
version record and its directly downloadable source archive. Those links are
also Sonic's source-code availability notice for the MPL-2.0 Covered Software
included in executable form, including `cssparser`, `cssparser-macros`,
`dtoa-short`, `option-ext`, and `selectors`. The exact versions remain locked
by `src-tauri/Cargo.lock` and listed in the release SBOM.

Build-only tools such as Tauri CLI, Vite, TypeScript, cargo-audit,
cargo-cyclonedx, cargo-about, and CycloneDX's npm generator are not installed
as independent runtime components. Their licenses continue to govern their
use in the release pipeline.

## Included notice files

An official v0.1.4 release includes or installs:

- Sonic's proprietary `LICENSE`;
- this `THIRD_PARTY_NOTICES.md`;
- the full CPython 3.13.14 license and bundled notices;
- Deno's exact license notice;
- yt-dlp zipimport, Meriyah, and Astring terms;
- GNU GPLv3 and LGPLv3 texts accompanying the optional LGPLv3 FFmpeg notice;
- the Barlow Condensed SIL Open Font License;
- generated Rust and npm dependency notice files;
- CycloneDX npm and Cargo SBOMs, the dependency license report, tool manifest,
  build configuration, and release checksums.

This document records provenance and release policy. It is not legal advice.
