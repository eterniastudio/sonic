# Sonic

**Turn YouTube beat links into organized, DAW-ready audio-without relying on an online converter.**

Sonic is a local-first desktop app built for producers. Paste a YouTube URL, analyze the musical metadata in the title and description, review the detected BPM, key, tuning, and detune, then export the audio in the format your session needs.

[![CI](https://github.com/eterniastudio/sonic/actions/workflows/ci.yml/badge.svg)](https://github.com/eterniastudio/sonic/actions/workflows/ci.yml)
[![Windows release](https://github.com/eterniastudio/sonic/actions/workflows/release.yml/badge.svg)](https://github.com/eterniastudio/sonic/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/eterniastudio/sonic?display_name=tag&sort=semver)](https://github.com/eterniastudio/sonic/releases/latest)

[**Download the latest Windows release**](https://github.com/eterniastudio/sonic/releases/latest)

![Sonic analyzed workspace](docs/sonic-analyzed.png)

## Built for producer workflows

Sonic replaces ad-heavy converter sites with a focused desktop workflow:

- **Analyze before downloading.** Inspect the source and detected musical data first.
- **Find useful metadata automatically.** Detect labelled BPM, musical key, detune, and tuning references.
- **Verify every result.** See the exact title or description text that produced each match.
- **Keep creative control.** Edit BPM, key, and detune before export.
- **Export for the session.** Save the original audio stream or convert it to WAV, MP3, or M4A.
- **Track the full job.** View progress, speed, ETA, conversion status, cancellation, and the final file location.
- **Get cleaner filenames.** Generate producer-friendly names from the detected musical data.
- **Work locally.** Download, conversion, filename generation, and metadata parsing run on your machine.

Sonic has no accounts, subscriptions, browser extensions, analytics, or hosted conversion service.

## Download for Windows

Sonic currently targets **Windows 10/11 x64**.

Download the latest installer from the [GitHub Releases page](https://github.com/eterniastudio/sonic/releases/latest). Each release includes:

- `Sonic_<version>_x64-setup.exe` - the Windows NSIS installer.
- `SHA256SUMS.txt` - the SHA-256 checksum for installer verification.

The installer bundles yt-dlp, FFmpeg, ffprobe, and Deno. You do not need to install Node.js, Rust, Python, FFmpeg, or yt-dlp to use Sonic.

Sonic uses Microsoft WebView2. It is included with current Windows installations and can be installed through Microsoft's WebView2 bootstrapper when required.

> **Windows SmartScreen:** Unsigned builds may display a warning. Choose **More info**, verify the download source and checksum, then select **Run anyway** only when you trust the file.

## Quick start

1. Download the latest x64 installer from the [Releases page](https://github.com/eterniastudio/sonic/releases/latest).
2. Run the installer and open Sonic.
3. Paste a YouTube video URL into the top bar.
4. Select **Analyze**.
5. Review or edit **Tempo**, **Musical key**, and **Detune**.
6. Choose an output format and destination.
7. Select **Download**.

> Use Sonic only with media you are authorized to save. Sonic does not bypass private-video access, geographic restrictions, or account authentication.

## Musical metadata detection

Sonic scans the video title and description for producer-friendly metadata. It rejects common false positives and shows the source evidence behind every detected value.

### BPM

Recognized examples:

```text
BPM: 144
144 BPM
Tempo 144
72 / 144 BPM
```

Timestamps, years, bitrates, and unrelated numbers are rejected. When two labelled values form a half-time pair, Sonic keeps the alternate BPM visible instead of silently discarding it.

### Musical key

Recognized examples:

```text
KEY: F# minor
Key - F♯m
Ab major
C Dorian
11A
```

The parser supports major and minor keys, modes, compact producer notation, Unicode sharp and flat characters, and Camelot keys. Supported keys are mapped to Camelot notation where possible.

### Detune and tuning

Recognized examples:

```text
Detuned -32 cents
-31.8¢
Down 1 semitone
Tuning: A=432Hz
```

Explicit cent values take priority. Sonic also understands semitones, half-steps, directional language, and tuning references such as `A=432Hz`. When a tuning frequency is present, Sonic calculates its cent offset relative to A440.

When labelled values conflict, Sonic surfaces a warning and leaves the final choice to you.

## Output formats

| Format | Best for |
| --- | --- |
| **Original** | Keeping the best available source audio stream without an additional conversion step. |
| **WAV** | DAW sessions, editing, and sample workflows that benefit from a straightforward DAW-compatible file. |
| **MP3** | Compact files with broad playback compatibility. |
| **M4A** | Efficient AAC audio with strong quality per megabyte. |

> Converting a compressed source to WAV does not restore lost quality. It creates a convenient, DAW-compatible file from the available source.

## Privacy and security

Sonic does not upload media to a third-party conversion service. It connects to YouTube to inspect and download the requested source; metadata parsing and media conversion happen locally.

The app also applies the following safeguards:

- Runs yt-dlp, FFmpeg, ffprobe, and Deno as bundled local sidecars.
- Disables user yt-dlp configuration files, plugins, remote components, self-updates, playlist expansion, and shell expansion.
- Validates download paths and filenames before passing them to local tools.
- Uses a dedicated `Downloads/Sonic` folder by default.
- Supports cancellation and cleans up active Windows process trees.
- Fetches release sidecars from official upstream artifacts and verifies their checksums through `scripts/fetch-tools.ps1`.
- Publishes a SHA-256 checksum file with GitHub release installers.

Sonic is **local-first**, not offline. A network connection is still required to inspect or download a YouTube source.

## Current scope

The current release supports:

- One YouTube video at a time.
- Audio download and conversion.
- Windows 10/11 x64.
- Manual review and editing of detected metadata.

The following are intentionally out of scope:

- Playlist downloads.
- Authenticated browser cookies.
- Private or account-gated videos.
- Geographic-restriction bypassing.
- Live-source downloads.
- Video export.

## Troubleshooting

### The installer does not start

Install or repair Microsoft WebView2, then run the installer again. If SmartScreen blocks an unsigned build, verify the downloaded checksum before choosing **More info** and **Run anyway**.

### Sonic says the local engine is not ready

One or more bundled sidecars may be missing or blocked by antivirus software. In a development checkout, run:

```powershell
npm run tools:fetch
```

Restart Sonic afterward. The startup status identifies whether yt-dlp, FFmpeg, ffprobe, and Deno are available.

### Sonic did not find a BPM or key

Not every title or description contains structured musical metadata. The fields remain editable, so you can enter the values manually. Open **How this was detected** to review any matches Sonic did find.

### A live video cannot be downloaded

Sonic intentionally rejects live sources. Wait until the stream has ended, then analyze the completed video.

## Architecture

```text
React + TypeScript UI
          |
          v
Tauri 2 commands and events
          |
          +--> yt-dlp (metadata + source audio)
          +--> Deno (yt-dlp JavaScript challenge runtime)
          +--> FFmpeg / ffprobe (format conversion + progress)
```

The desktop shell is built with Tauri 2. The frontend uses React and Vite. The Rust backend owns URL validation, sidecar execution, cancellation, progress parsing, safe-path handling, and musical metadata extraction.

## Repository layout

```text
src/
  App.tsx              React workflow and native command wiring
  App.css              Sonic visual system and responsive layout
src-tauri/
  src/lib.rs           Tauri commands, download jobs, and progress events
  src/metadata.rs      BPM, key, detune, and tuning parser
  binaries/            Locally fetched release sidecars (ignored)
  icons/               App, installer, and platform icon assets
scripts/
  fetch-tools.ps1      Fetches and verifies local media tools
.github/workflows/
  ci.yml               TypeScript, Rust, and frontend validation
  release.yml          Windows installer and GitHub release automation
```

## Development

### Requirements

- Windows 10/11 x64
- Node.js 22+
- Rust stable with the `x86_64-pc-windows-msvc` target
- Microsoft C++ Build Tools
- Microsoft WebView2

### Install dependencies and fetch sidecars

```powershell
npm install
npm run tools:fetch
```

The fetch script downloads the pinned yt-dlp, FFmpeg/ffprobe, and Deno artifacts, verifies their published SHA-256 checksums, and places them in `src-tauri/binaries`.

### Run the desktop app

```powershell
npm run tauri dev
```

For frontend-only UI work:

```powershell
npm run dev
```

The browser preview uses a deterministic demo video and simulated progress. Real downloads require the Tauri desktop build.

### Validate the project

```powershell
npm run check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

### Build a local installer

```powershell
npm run tools:fetch
npm run tauri build
```

The installer is written to:

```text
src-tauri/target/release/bundle/nsis/Sonic_<version>_x64-setup.exe
```

## Release automation

GitHub Actions builds the Windows installer so end users do not need to assemble the project locally.

### Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main` or `master`. It validates:

- TypeScript checks.
- The Vite production build.
- Rust formatting.
- Rust unit tests.

### Versioned releases

`.github/workflows/release.yml` runs for tags matching `v*`. The workflow:

1. Starts from a clean Windows runner.
2. Installs Node.js and Rust.
3. Fetches and verifies the pinned media sidecars.
4. Builds the Tauri NSIS installer.
5. Generates `SHA256SUMS.txt`.
6. Uploads the installer artifact.
7. Creates a GitHub Release with the installer and checksum attached.

To publish a release:

```powershell
git checkout main
git pull

# Keep these files on the same version:
# package.json
# package-lock.json
# src-tauri/Cargo.toml
# src-tauri/Cargo.lock
# src-tauri/tauri.conf.json

git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "release: v0.1.2"
git tag v0.1.2
git push origin main --follow-tags
```

Pushing the tag triggers the release. The repository's GitHub Actions permissions must allow `contents: write` for the release workflow.

## Project status

Sonic is a focused, private-use Windows release from Eternia Studios. Its current scope is intentionally narrow: analyze one YouTube source, review its musical metadata, and export the audio locally in a producer-friendly format.
