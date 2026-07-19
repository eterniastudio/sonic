# Security policy

## Supported versions

Sonic is pre-1.0 software. Security fixes are provided on a best-effort basis
for the latest published release only. Older releases and local builds from
unreleased commits are not supported. Users should reproduce a report against
the latest release when it is safe to do so.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability and do not include
secrets, private media URLs, cookies, tokens, or personal filesystem paths in
public discussions.

Use the repository's private GitHub Security Advisory form:

**[Report a vulnerability privately](https://github.com/eterniastudio/sonic/security/advisories/new)**

If that form is unavailable, open a public issue containing no vulnerability
details and ask a maintainer to enable a private reporting channel. Do not send
an exploit or sensitive evidence through that public issue.

Include, when applicable:

- the Sonic version and installer filename;
- Windows version and architecture;
- affected component and whether the issue reproduces in a clean profile;
- concise reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- security impact and realistic attack prerequisites;
- relevant logs with URLs, tokens, usernames, and paths redacted; and
- whether the issue affects bundled CPython/yt-dlp or the optional
  runtime-downloaded Deno/FFmpeg engine.

## What happens next

Maintainers will use the private advisory to validate the report, identify
affected versions, coordinate a fix, and agree on disclosure timing. Please do
not disclose the issue publicly until a fix is available or a disclosure plan
has been agreed in the advisory. Do not access data that is not yours, disrupt
services, degrade other users' systems, or use social engineering while
researching Sonic.

No bounty, payment, response-time guarantee, or safe-harbor commitment is
offered by this policy. Any recognition will be coordinated with the reporter
and will respect a request for anonymity.

## Third-party vulnerabilities

Sonic bundles an official CPython runtime and yt-dlp zipimport package,
downloads pinned Deno/FFmpeg tools directly from upstream after consent, and
incorporates open-source libraries. A report that affects Sonic's packaging,
verification, invocation, configuration, or trust boundary belongs here. A
vulnerability solely within an upstream project should also be reported under
that project's security policy. Before contacting an upstream project, avoid
exposing a Sonic-specific vulnerability that has not yet been coordinated
privately.

The exact runtime tool versions are recorded in
[`scripts/tool-manifest.json`](scripts/tool-manifest.json), and principal
licenses and sources are recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Update trust

Sonic checks an HTTPS static manifest attached to the latest release under the
`eterniastudio/sonic` repository. An update is installed only after the Tauri
updater validates its signature against the public key embedded in the
application. The matching private key is stored outside source control and in
the repository's protected Actions secrets.

Reports are especially important if update metadata can redirect Sonic to an
untrusted host, signature verification can be bypassed, a downgrade occurs
without explicit policy, or private signing material appears in source,
artifacts, logs, caches, or diagnostics. The updater signature is separate
from Authenticode; Windows SmartScreen may still warn for installers without a
commercial code-signing certificate.

## Local data and destructive actions

Sonic v0.2 keeps settings, queue requests/events, and optional Beat Library
records in a local SQLite database. Metadata sidecars and exported diagnostics
are JSON files; preview audio is stored temporarily in the application cache.

Reports are especially useful when they show that Sonic can:

- delete or overwrite a file that is not the exact recorded Library audio or
  matching sidecar;
- follow a symbolic link, junction, mount point, reparse point, or raw Windows
  device path during intake, recovery, preview cleanup, publication, or
  uninstall;
- escape a selected output folder or the scoped preview cache;
- publish only one half of an audio/sidecar pair without safe recovery;
- expose private URLs, local source paths, usernames, or output paths in an
  exported report advertised as redacted;
- accept stale queue revisions that reorder or modify another state; or
- execute user-controlled text as a shell command or arbitrary FFmpeg option.

Do not attach a real Sonic database, media sidecar, diagnostic export, or audio
file to a public report. Create a minimal synthetic reproduction and redact
identifiers before sharing it through the private advisory.
