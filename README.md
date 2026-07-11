# Sonic

Sonic is a local-first media intake and music-metadata tool for beat producers.
Paste an authorized YouTube video URL, inspect the BPM, key, tuning, and detune
markers in its title and description, then export the audio in a DAW-friendly
format.

[![CI](https://github.com/eterniastudio/sonic/actions/workflows/ci.yml/badge.svg)](https://github.com/eterniastudio/sonic/actions/workflows/ci.yml)
[![Windows release](https://github.com/eterniastudio/sonic/actions/workflows/release.yml/badge.svg)](https://github.com/eterniastudio/sonic/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/eterniastudio/sonic?display_name=tag&sort=semver)](https://github.com/eterniastudio/sonic/releases/latest)

![Sonic analyzed workspace](docs/sonic-analyzed.png)

Sonic is published from Eternia Studios' personal GitHub account,
[`@eterniastudio`](https://github.com/eterniastudio).

## Why Sonic exists

Producer workflows should not depend on ad-filled converter websites. Sonic
keeps metadata parsing, conversion, naming, and file management on the local
machine. There are no Sonic accounts, subscriptions, browser extensions,
analytics, or hosted conversion services.

Sonic is for media you own or are authorized to download. It does not bypass
private-video access, geographic restrictions, or account authentication, and
it is not affiliated with or endorsed by YouTube.

## Features

- Inspect a YouTube video before downloading anything.
- Extract labelled BPM values and preserve half-time alternatives such as
  `72 / 144 BPM`.
- Parse major, minor, modal, sharp/flat, compact producer, and Camelot keys.
- Detect detune written in cents, semitones, half-steps, or directional text.
- Convert tuning references such as `A=432Hz` into a cents offset from A440.
- Show the exact title or description text behind every detected value.
- Surface conflicting labelled metadata instead of silently choosing one.
- Edit BPM, key, detune, filename, format, and destination before export.
- Export original audio, WAV, 320 kbps MP3, or M4A/AAC, remuxing source AAC
  when possible and converting otherwise.
- Stream progress, speed, ETA, conversion state, cancellation, and final path.
- Publish finished files atomically without overwriting an existing file.
- Run one job at a time in a per-job staging workspace.

## Download

Download the latest Windows x64 installer from
[Eternia Studios releases](https://github.com/eterniastudio/sonic/releases/latest).
The release is currently unsigned, so Windows SmartScreen may ask
for confirmation. Verify the installer against `SHA256SUMS.txt` before running
it.

Each release includes:

- `Sonic_<version>_x64-setup.exe` — the NSIS installer;
- `SHA256SUMS.txt` — SHA-256 values for every attached release file;
- npm and Cargo CycloneDX SBOMs;
- a machine-readable dependency-license report;
- exact npm and Rust runtime dependency notices;
- the pinned tool manifest and FFmpeg build configuration;
- Sonic's license, third-party notices, and applicable license texts; and
- a GitHub build-provenance attestation.

The installer contains pinned yt-dlp and CPython components. Users do not need
Node.js, Rust, Python, yt-dlp, Deno, or FFmpeg installed globally.

### First-run media engine setup

FFmpeg, ffprobe, and Deno are not redistributed inside the Sonic installer.
When they are missing, Sonic shows a **Set up engine** prompt. After explicit
consent, Sonic downloads pinned artifacts directly from BtbN and Deno's
immutable GitHub releases, verifies every archive and executable, records
provenance, and re-verifies the executables before every launch.

- Download size: about 180 MiB total.
- Source: retained month-end BtbN build `autobuild-2026-06-30-13-34`.
- Local path: `%LOCALAPPDATA%\studio.eternia.sonic\media-engine`.
- License: LGPL-3.0-or-later; the upstream license is stored beside the tools.
- Cleanup: Sonic's uninstaller calls a reparse-aware cleanup routine.

The month-end upstream asset has a longer retention window than BtbN's daily
builds, but it is not permanent. A future Sonic maintenance release must move
the pin before upstream retention expires. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for exact URLs, hashes,
source references, and licensing details.

### Pinned media components

| Component | Version | Delivery | License |
| --- | --- | --- | --- |
| yt-dlp zipimport package | 2026.07.04 | Bundled | Unlicense with ISC/MIT components |
| CPython embedded runtime | 3.13.14 | Bundled | PSF-2.0 and bundled notices |
| Deno | 2.9.2 | User-approved direct upstream download | MIT |
| FFmpeg and ffprobe | `N-125365-g9a01c1cb6a-20260630` | User-approved direct upstream download | LGPL-3.0-or-later |

The bundled component set and optional engine artifact are pinned in
[`scripts/tool-manifest.json`](scripts/tool-manifest.json). Every artifact has
an exact versioned URL and SHA-256 value. This makes the media-tool selection
reviewable; it does not claim bit-for-bit reproducibility of the whole NSIS
installer or GitHub-hosted Windows runner.

Sonic targets Windows 10/11 x64 and uses Microsoft WebView2.

## Quick start

1. Download the latest x64 setup executable and `SHA256SUMS.txt`.
2. Verify the installer hash, then run the installer.
3. Open Sonic.
4. Choose **Set up engine** when prompted and allow the verified upstream
   download to finish.
5. Paste an authorized YouTube video URL and choose **Analyze**.
6. Review or edit Tempo, Musical key, Detune, filename, and output settings.
7. Choose **Download**.

## Metadata extraction

Sonic searches the video title and description for producer-oriented labels.

### BPM

```text
BPM: 144
144 BPM
Tempo 144
72 / 144 BPM
```

Timestamps, years, bitrates, and unrelated numbers are rejected. Labelled
half-time pairs remain visible as alternatives.

### Key

```text
KEY: F# minor
Key - F♯m
Ab major
C Dorian
11A
```

Common Unicode sharp and flat characters are normalized, and supported keys
are mapped to Camelot notation.

### Detune and tuning

```text
Detuned -32 cents
-31.8¢
Down 1 semitone
Tuning: A=432Hz
```

Explicit cents take priority. When a tuning frequency is present, Sonic
calculates the equivalent cents offset relative to A440. The evidence panel
shows where each result came from.

## Output formats

| Format | Behavior |
| --- | --- |
| Original | Saves the best available source audio without a requested conversion. |
| WAV | Produces an uncompressed DAW-friendly file; it does not improve source fidelity. |
| MP3 | Encodes a widely compatible 320 kbps MP3. |
| M4A | Remuxes source AAC without re-encoding when possible; otherwise converts the selected source to AAC in an M4A container without claiming a fixed bitrate. |

## Privacy and security model

- Sonic contacts the source provider when inspecting or downloading a URL.
- The optional setup contacts GitHub/BtbN and GitHub/Deno to obtain the pinned
  engine archives. Retrying setup can contact them again.
- yt-dlp user configuration, plugin directories, remote components,
  self-updates, playlist expansion, and shell expansion are disabled.
- yt-dlp runs through an isolated official CPython embedded runtime and an
  explicit, hash-verified local Deno path.
- FFmpeg and ffprobe must match the manifest SHA-256 values before launch.
- User-controlled `PATH` entries are not inherited by the media subprocesses.
- URLs, output roots, extensions, and filenames are validated in Rust.
- Conversion occurs in a per-job staging directory under the selected output
  folder; this is a staging boundary, not a separate OS privacy boundary.
- The final file is moved with an atomic no-replace operation, so a concurrent
  file creation cannot be overwritten.
- Cancellation terminates the Windows child-process tree and conservatively
  cleans the staging entry.

Sonic is local-first, not offline. It does not send product analytics or use a
Sonic-hosted conversion backend.

## Architecture

```text
React + TypeScript UI
          |
          v
Tauri 2 commands and events
          |
          +--> CPython --> yt-dlp zipimport (metadata + source audio)
          +--> verified Deno (yt-dlp JavaScript challenge runtime)
          +--> verified FFmpeg / ffprobe (conversion + probing)
```

The Rust backend owns URL validation, exact tool resolution, checksum gates,
single-job concurrency, staging, atomic publication, cancellation, progress
parsing, and music-metadata extraction.

## Repository layout

```text
src/
  App.tsx                 React workflow and native command wiring
  App.css                 Sonic visual system and responsive layout
src-tauri/
  src/lib.rs              Tauri commands, jobs, process and file safety
  src/metadata.rs         BPM, key, detune, and tuning parser
  binaries/               Reproducibly fetched dev/build tools (ignored)
  icons/                  App and installer icon assets
  windows/                Safe NSIS install/uninstall hooks
scripts/
  tool-manifest.json      Pinned versions, URLs, delivery modes, and hashes
  fetch-tools.ps1         Fetches and verifies development/build components
  install-media-engine.ps1
                          User-approved verified runtime engine setup
  validate-release-version.ps1
                          Enforces tag and source version agreement
  generate-license-report.ps1
                          Produces the machine-readable license inventory
  generate-npm-notices.ps1
                          Collects exact npm runtime notices
  smoke-test-installer.ps1
                          Clean-runner installer, runtime, icon, and uninstall gate
about.toml                Cargo runtime-license policy
.github/workflows/
  ci.yml                  Audits, checks, tests, SBOMs, and notices
  release.yml             Build/smoke job plus isolated attest/publish job
```

## Development setup

### Requirements

- Windows 10/11 x64
- Node.js 22+
- Rust with the `x86_64-pc-windows-msvc` target
- cargo-about 0.9.1 when producing an installer
- Microsoft C++ Build Tools
- WebView2

The release workflow pins Node.js 22.23.1 and Rust 1.94.0.

### Install dependencies and fetch tools

```powershell
npm ci
npm run tools:fetch
```

The fetch script verifies the pinned yt-dlp zipimport package, CPython embedded
runtime, and development copies of Deno and FFmpeg. Generated executables and
runtime files stay ignored under `src-tauri/binaries`.

### Run Sonic

```powershell
npm run tauri dev
```

For UI-only work:

```powershell
npm run dev
```

The browser preview uses local demo artwork and simulated progress. Real
inspection and downloads require the Tauri desktop build.

### Validate

```powershell
npm run check
npm run build
npm audit --audit-level=high
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
cargo audit --file src-tauri/Cargo.lock
```

The CI workflow additionally creates CycloneDX SBOMs, a machine-readable
license report, npm runtime notices, and Cargo license output.

### Build a local installer

```powershell
npm run tools:fetch
cargo install --locked cargo-about --version 0.9.1 --features cli
npm run tauri build
```

Tauri's release prebuild runs `npm run notices:generate`, so a clean local
installer cannot be built without regenerating both exact notice files.

Output:

```text
src-tauri/target/release/bundle/nsis/Sonic_<version>_x64-setup.exe
```

## Release automation

### CI

`.github/workflows/ci.yml` runs on pull requests and pushes to the default
branch. It checks version consistency, npm audit, TypeScript, Vite, Rust
formatting, Clippy with warnings denied, tests, cargo-audit, verified tool
fetching, SBOM generation, and exact dependency notices.

### Tagged releases

`.github/workflows/release.yml` runs for `v*` tags:

1. A read-only build job validates all versions and dependencies.
2. It builds the NSIS installer on a clean Windows runner.
3. The smoke test checks a clean install, installer/app/uninstaller icons,
   bundled Python/yt-dlp, absence of redistributed Deno/FFmpeg, verified
   runtime-engine setup, app startup, and uninstall cleanup.
4. It generates checksums, SBOMs, and complete generated notices.
5. It uploads a verified release-candidate artifact.
6. A separate short job receives write and OIDC permissions, downloads only
   that candidate, creates the provenance attestation, and publishes the
   unsigned GitHub Release.

GitHub Actions are pinned to reviewed commit SHAs, checkout credentials are
not persisted, and the dependency/build job never receives release-write
permissions.

## Troubleshooting

### Windows blocks the installer

The release is not Authenticode-signed. Download `SHA256SUMS.txt` from the same
release, verify the installer, then use **More info → Run anyway** only if the
hash matches.

### Media engine setup fails

Sonic needs network access to the exact GitHub/BtbN and GitHub/Deno assets
during setup. Check the connection, free roughly 450 MiB for
download/extraction, and choose
**Set up engine** again. Partial work directories are removed under a setup
mutex. Sonic will never use an engine whose hashes do not match the manifest.

For a development checkout, refresh all pinned tools with:

```powershell
npm run tools:fetch
```

### Sonic cannot find BPM or key

Not every description contains structured musical metadata. The fields remain
editable. Open the evidence panel to see any matches Sonic did find.

### A live video is rejected

Live sources are intentionally blocked. Wait for the stream to end and inspect
the finished video.

## Project status and policy

Sonic v0.1.4 is an unsigned Windows release from Eternia Studios. It handles
one authorized YouTube video at a time. Playlists, authenticated browser
cookies, video export, and access-control bypasses are out of scope.

- [LICENSE](LICENSE) — Sonic's proprietary source and binary-use terms.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — exact third-party
  provenance and terms.
- [SECURITY.md](SECURITY.md) — private vulnerability-reporting process.
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution and release requirements.
