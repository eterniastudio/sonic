# Contributing to Sonic

Thank you for considering an improvement to Sonic. This is a source-available,
proprietary project maintained by Eternia Studios; it is **not an open-source
project**. The root [LICENSE](LICENSE) applies to Sonic's original materials.

## Before contributing

- Search existing issues and pull requests before starting work.
- For a substantial feature, architecture change, new media source, or new
  dependency, open an issue and agree on scope with a maintainer first.
- Report suspected vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), never in a public issue.
- Do not submit code intended to bypass DRM, paywalls, authentication, access
  controls, platform safeguards, or copyright protections.
- Features must support media the user owns or is authorized to download and
  must not collect credentials, private URLs, or usage data without explicit
  product approval and informed user consent.

Eternia Studios may decline any contribution and does not promise that an
accepted contribution will appear in a release.

## Contributor terms

By submitting a patch, pull request, design, documentation change, or other
contribution, you represent that you have the right to submit it and that it
does not knowingly infringe another party's rights.

You retain copyright in your contribution. You grant Eternia Studios a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use,
reproduce, modify, prepare derivative works of, publicly display, publicly
perform, distribute, sublicense, commercialize, and otherwise exploit your
contribution as part of Sonic and related Eternia Studios products, including
under proprietary terms. You also grant any patent rights you control that
are necessarily infringed by your contribution as incorporated into Sonic.

Do not submit a contribution if you cannot grant those rights. Clearly identify
third-party code, generated material, or assets and provide their provenance
and license before submission. Code copied from incompatible or unknown
sources will not be accepted. These contributor terms do not grant you a
license to any other part of Sonic.

## Development setup

Requirements:

- Windows 10 or later;
- Node.js 22 and npm;
- stable Rust with the MSVC target and the Tauri Windows prerequisites; and
- PowerShell 5.1 or later.

Install and validate the project:

```powershell
npm ci
npm run tools:fetch
npm run test:coverage
npm run check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
cargo audit --file src-tauri/Cargo.lock
```

Run the desktop application with:

```powershell
npm run tauri dev
```

Keep local media, cookies, credentials, downloaded files, generated sidecar
binaries, build output, and diagnostic logs out of commits.

## Pull-request rules

1. Branch from the current `main` branch and keep the change focused.
2. Explain the user problem, the chosen behavior, security implications, and
   how the change was tested.
3. Add or update tests for parser, filesystem, process, or state-management
   behavior. Include manual verification steps for UI and installer changes.
4. Preserve the native trust boundary: URL validation, output paths, process
   execution, cancellation, and cleanup remain owned by Rust, not arbitrary
   renderer code.
5. Do not add telemetry, network services, self-updating sidecars, credential
   import, remote plugins, or executable downloads without prior maintainer
   approval and an explicit threat-model review.
6. Keep user-facing copy honest about conversion quality and about the
   difference between declared metadata and audio-derived analysis.
7. Update documentation and third-party notices when behavior, dependencies,
   packaging, or distribution changes.
8. Ensure every required local check passes before requesting review.

## v0.2 architecture boundaries

- `src/app` owns renderer state, reconciliation, and lifecycle cleanup.
- `src/domain` contains UI-independent TypeScript models and formatting.
- `src/features` owns the Session, Inspector, Library, Settings, and Preview
  Transport surfaces.
- `src/services` is the only frontend layer that knows native IPC wire shapes.
  New Rust fields require normalizer and checked-in contract-fixture coverage.
- `src-tauri/src/commands.rs` validates and coordinates IPC requests; it should
  not become a second job runner.
- `acquisition.rs`, `jobs.rs`, `filesystem.rs`, `presets.rs`, `preview.rs`,
  `sidecar.rs`, `storage.rs`, and `tools.rs` own their corresponding native
  policies. Keep user-controlled paths and process arguments inside this Rust
  trust boundary.

Queue events must remain compact summaries. Retrieve full persisted job
requests explicitly rather than attaching descriptions, evidence, and paths to
every progress event. Library deletion and recovery changes require adversarial
tests for replaced files, reparse points, partial publication, and stale
revisions.

## Dependency and bundled-tool changes

Runtime executables are deliberately pinned in
[`scripts/tool-manifest.json`](scripts/tool-manifest.json). A tool update must:

- use an immutable upstream release URL and exact version or commit;
- update archive and extracted-executable SHA-256 hashes;
- link the upstream release, exact corresponding source, license, and build
  configuration;
- review security, behavior, and distribution-license changes;
- update [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md);
- run `npm run tools:fetch` from a clean tool directory and verify versions and
  hashes; and
- update release source archives, SBOM, and license reports.

Do not commit generated sidecar executables. Do not change a pinned artifact to
a moving `latest`, branch, or nightly URL.

For npm and Cargo changes, commit the corresponding lockfile and explain why
the new dependency is needed. Prefer a small, maintained dependency with a
license compatible with proprietary distribution. Copyleft or unusually
restrictive dependencies require maintainer and compliance review before use.

## Style and commits

- Follow the existing TypeScript, React, Rust, and CSS conventions.
- Keep accessibility, keyboard operation, reduced motion, and responsive
  layouts working.
- Run Rust formatting rather than hand-formatting generated diffs.
- Write concise, imperative commit subjects and avoid mixing unrelated
  refactors with a behavior change.
- Never rewrite or remove another contributor's work merely to reduce the size
  of a pull request.

By opening a pull request, you confirm that you have read and agree to these
contribution rules.
