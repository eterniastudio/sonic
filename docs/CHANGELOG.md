# What has changed in Sonic

This history brings together all nine pull requests merged before the current
improvement work. Dates are merge dates in Eastern Time (America/New_York).
Each entry describes what became useful in the app. Historical test results describe that version;
they are not a claim that every later version has been tested the same way.

## 2.1.0 — November 2026

### Sonic V2 is now Sonic

The app, installer, window and shortcuts are now called **Sonic**. Installing
`Sonic-2.1.0-setup.exe` upgrades an existing Sonic V2 install in place. On first
launch Sonic moves `%APPDATA%\Sonic V2` to `%APPDATA%\Sonic`, or keeps using the old
folder if the move is blocked, so the library, settings and media engine carry over.
An existing `Music\Sonic V2` export folder stays the default. Sidecar and track-list
files keep their `sonic-v2/...` schema names so older files still load.

### Automatic updates

The installed app checks GitHub Releases shortly after launch and every few hours,
downloads a newer version in the background, and installs it when you close Sonic.
**Restart to update** in the title bar installs it right away. **Settings → About**
shows the version and update status, checks on demand, and links to release notes
and the issue tracker.

### Safer when something goes wrong

- A render error now shows a recovery screen with **Reload** instead of a blank,
  frameless window.
- If the window fails to load or its process crashes, Sonic shows it and offers
  **Reload** or **Quit**, instead of leaving an invisible window that blocks relaunch.
- The startup error dialog names the data folder and can open it.
- **Set up / update engine** refreshes a Sonic-managed `yt-dlp` older than a week,
  and download errors that come from an outdated `yt-dlp` now say so.
- Only `.exe` tools on PATH are used on Windows; a `.cmd` or `.bat` shim used to look
  available and then fail on every run.

## October 24, 2026

### Download from many more sites

Besides YouTube and SoundCloud, the download box now accepts Bandcamp tracks, Vimeo,
Mixcloud, Audiomack, Dailymotion, Twitch clips and past broadcasts, TikTok, public
Instagram reels and posts, Reddit video posts, Streamable, X (Twitter) video posts,
Internet Archive items, and direct links to audio or video files. Bandcamp album
links open the same track review as YouTube playlists. Each link is checked against
its site's rules when you paste it. Profiles and channels are rejected with a reason
that names the site, and download errors are worded per site. YouTube artwork still
comes from the video thumbnail. Other sites use the thumbnail yt-dlp reports. A new
**Allow other sites** setting, off by default, passes any other public https page to
yt-dlp's generic extractor. Links whose host resolves to your own computer or a private
network are refused before inspection, download and cover fetch.
In the library, **Open on …** names the beat's site, and smart collections can filter
by every source. Existing library records, smart collections and settings load as before.

### Library tools for working next to a DAW

| What you can do | How |
| --- | --- |
| Drag tracks into a DAW or Explorer | Drag a library row; a multi-selection drags together, up to 100 files. Sonic's main process resolves the files from record ids, so the interface still never handles file paths. |
| Find compatible tracks | Right-click a track and choose **Find compatible tracks**, or press **C** on a focused row. The list shows the same Camelot key, ±1 on the wheel, and the relative key, at ±4 BPM including half and double time. The banner shows the exact ranges and lets you change the tolerance. |
| Favorite from the keyboard | Press **F** on a focused row, or on a selection, to toggle favorite. |
| Recently added, Needs review, Duplicates | Built-in views beside Favorites. Needs review lists tracks with no BPM or key, or with a source-versus-audio disagreement on either. |
| Clean up duplicates | Records that share a source link or identical audio are grouped. Keep one and the others leave the library. Their favorite, tags, notes and collection places move to the kept record. No audio file is deleted. |
| Export a track list | **Export list** saves the displayed or selected tracks as CSV or JSON, with title, producer, BPM, key, Camelot, duration, source, file name and collections. Full paths are never written. |
| Retry failed downloads at once | **Retry failed (n)** in the queue header and the command palette. |
| Queue a copied link | An opt-in setting, off by default (**Settings → Advanced → Link intake**). When Sonic regains focus, it offers to queue a supported copied link that isn't already queued. |

Saved settings and organization files from earlier versions load unchanged: the clipboard watch reads as off, and a saved built-in view reopens. Verified with new unit tests (`tests/library-tools.test.mjs`, plus handler checks in `tests/ipc-handlers.test.mjs`) and a hidden-window UI spec (`tests/library-tools.spec.mjs`). The drag test replaces Electron's `startDrag` to confirm which file is offered. It does not perform a real drop into a DAW.

### Tempo and key detection that reads beats the way producers label them

The analyser is now `sonic-dsp/5`. Tracks measured by the previous engine show up
in the Library's **Analyze** count, and your manual corrections are untouched.

- **Tempo** no longer lands on a cross-rhythm. House at 122 had read 81, and
  afrobeats or dembow at 100 had read 133. Trap and drill now read at their labelled
  130–165 BPM rate rather than half of it. The other octave is still offered as an
  alternative.
- **Key** no longer names the key a fifth away when a minor loop leans on its
  flat-seventh chord. An Am–G–F–G loop had read G major. Ambiguous relative
  major/minor material says so and lists both keys. Drum loops without harmony no
  longer get a key.
- **Analysis is about twice as fast.** Key analysis takes 14 ms instead of 30 ms
  on the reference clip; a 150 s tempo window takes 221 ms instead of 362 ms.
- **Titles:** the parser now reads `140 - 145 BPM` (as 140), `bpm 140/70`,
  `@ 140`, a lone `[140]`, `C sharp minor`, `in the key of G`, `08A` and
  `prod. @name`, and drops `Free for profit` from clean titles. Years, `808` and
  phrases like "a minor setback" are still never read as tempo or key.

Measured on 47 new generated producer-style beats: exact tempo went from 24 to 40
of 43, and confidently wrong keys from 15 to 2. On 28 real guitar recordings,
exact tempo went from 14 to 18 and wrong keys from 9 to 4. Existing
regression suites are unchanged. These are generated fixtures and a small
non-held-out guitar corpus, not a measurement on real beats. Details and limits
are kept in the project's internal notes.

### Large libraries stay responsive — details

With 5,000 to 20,000 tracks, everyday library changes do much less work:

- **Saving a change rewrites only what changed.** Sonic still saves the whole library file after each change, but it now re-encodes only the tracks that changed. Saving one analysis result took 685 ms at 20,000 tracks and now takes 134 ms, most of which is writing the file. At 5,000 tracks it went from 125 ms to 31 ms. The file format is unchanged.
- **The window receives only what changed.** A one-track change sent all 47.6 MB of the library to the window. It now sends 296 KB. Delivering and applying it took 953 ms and now takes 18 ms.
- **Search indexing waits until you search.** Filling in tempo and key no longer rebuilds the search index for every track analysed. It is built when you type a query, or once the library is quiet. Search results are unchanged.
- **Import review no longer slows down as the library grows.** Checking each file against the library took 101 ms at 20,000 tracks and now takes under 1 ms.
- Key filters are about ten times faster.

Opening the library is 14–52 ms slower, because saved tracks are now protected against accidental in-place edits. The first search after a change costs what an index rebuild cost before.

## October 21, 2026

### White Label: a full visual redesign

Sonic has a new look built on promo white-label records. In the dark theme, label-white type sits on black vinyl. In the light theme, the interface is the label stock itself. Square-cut panels, one-pixel rules and a single stamp-blue ink replace the old graphite cards and the five-accent picker. Saved accent settings still load and now resolve to stamp blue.

Every tempo and key value now shows where it came from, wherever you read it: library rows, the inspector, and the player.

| Mark | Meaning |
| --- | --- |
| **Bold printed figure** | Read from the source title, description or file name |
| Blue stamped box | Read from the file's own embedded tag |
| Dotted underline with three dots | Measured from the audio; the dots show analyser confidence |
| Handwritten figure | Your own correction, which always wins |

A legend above the library table spells this out. The inspector shows the track as a record. Its centre label carries the artwork, or, when there is none, the tempo and key written in their marks. The player's record turns while audio plays.

Type is now Archivo, with condensed caps for headings and figures, and Shantell Sans for manual corrections. Both are bundled locally under the SIL Open Font License, and Inter was removed. Layout, controls, keyboard access and accessible names are unchanged.

## October 9, 2026

### Test the app without interrupting your desktop — PR #9

Routine interface checks can run with Sonic's windows hidden using
`npm run test:ui:hidden`. They still exercise the real application, so working on
Sonic no longer has to open a series of test windows over your other work.
Tests that need real Windows window controls or pointer input still use the
visible test command. This changes the development workflow, not audio playback
or processing speed. Intermittent native Electron shutdown crashes were observed
in testing; successful reruns did not establish a fix for them.

### A clearer workspace, more sources, and faster library work — PR #8

The Library became a compact music workspace with source artwork, distinct
selection and playback states, a persistent waveform player, and clearer
tempo/key evidence. Dark and light themes use the same layout. The inspector
keeps the important controls visible at the minimum supported window size.

The final merged change also included later work beyond the PR's original design
description:

| What you can do | What changed |
| --- | --- |
| Bring in more music | Download individual SoundCloud tracks and review a YouTube playlist before choosing tracks to queue. Playlist reviews have explicit size limits; SoundCloud playlists and profiles are unsupported. |
| Reconnect moved audio | Use **Locate file…** or **Find missing files…** to verify matching audio and reconnect existing library records while keeping notes, collections, corrections, and listening positions. Imported originals remain read-only. |
| Preview downloads inside Sonic | **Preview in Sonic** uses the Library's player, avoiding a separate default media player and overlapping audio sources. |
| Browse with less repeated work | Playback notifications are bounded, unchanged search indexes and library records are reused, and file checks run with bounded concurrency. Queue progress and unrelated metadata changes no longer require every row to render again. |

The recorded 10,000-track search fixture averaged **1.16 ms** to reuse an index
versus **44.77 ms** to rebuild one. Controlled playback streams produced **10
notifications per second**, previously 60 or 120. These measure specific internal
operations on test fixtures; they do not establish overall app CPU use or a
universal speedup. Key detection was unchanged in this PR.

Live YouTube playlist downloads were not exercised in the documented playlist
verification; it used extractor fixtures and an isolated packaged smoke test.

### Keep your place while moving between views — PR #7

Switching from Library to Download or Settings and back now restores your search,
filters, selected tracks, inspector, and scroll position. Your listening queue
keeps the tracks you originally chose, even if you browse a different collection.
This browsing context lasts for the current app session. Unsaved edits and open
confirmation dialogs are not restored or submitted automatically.

## September 24, 2026

### Keep listening across views and resume where you stopped — PR #6

Audio continues when you leave Library because one app-wide player owns playback.
**Play one**, **Play results**, and **Play selected** create a stable listening
queue in the order you chose. Restarting Sonic restores your last track, volume,
and saved position paused, ready for you to resume. Saving problems remain visible
and can be retried. See playback verification.

## September 23, 2026

### Organize a project shortlist and work on several tracks — PR #5

Save notes and tags, build manual collections, or create smart collections from
search rules. Select several tracks to analyze or export together, with progress,
cancellation, and per-track failures. Collections follow stable track identities
instead of filenames, so a rename does not lose your shortlist. Retrying an export
after a library-save failure reconciles the existing output instead of making
another copy. See collections verification.

### Check key and tempo against independently labeled recordings — PR #4

Added a repeatable audio benchmark so analyzer changes can be checked against
known musical references, without feeding titles or tags to the analyzer. In the
original 28-recording guitar cohort, the analyzer's primary answer matched the
reference key on **11/28** recordings and tempo on **10/28**. Some other results
were inconclusive or half/double-time readings. These were baseline measurements,
not an improvement to the detector and not an accuracy claim for a full beat
library. The corpus had no real negative examples, so false positives on real
nonmusical recordings were not measured. See the
benchmark and its limits.

### Import your own audio without changing the originals — PR #3

Add local files or folders, review duplicates, and analyze, preview, search, or
correct their library metadata. Sonic references those files in place. Renaming
or removing an imported record affects the Library entry, while the original
audio stays untouched. Choose **re-export** to create a separate Sonic-owned copy
with your reviewed metadata. Failed imports can be retried individually.

### More dependable analysis, clearer metadata, and better search — PR #2

Analysis batches wait until their queued state is saved, and cancellation and
shutdown settle their status more consistently. Concurrent re-exports use separate
temporary folders. The metadata editor explains whether a value came from source
text, tags, audio, or your correction, keeps untouched fields up to date, and
reports whether file tags or sidecars still need attention. Library search gained
relevance sorting and BPM, key, and review filters.

### Stop cancelled or failed analysis from looking successful — PR #1

Repeated batch requests no longer schedule the same track twice. Cancelled
reanalysis preserves the previous result, late cancelled results are rejected,
and missing or removed tracks do not leave misleading queued badges. A failed
save is reported as a failure even when the audio calculation completed. The
change also added coordinator regressions and an architecture review. Its first
verification covered those focused tests; the full Windows app and packaging
were not verified in that PR's original environment.

## Reading the older accuracy and verification notes

PRs #1–#9 did not improve the acoustic key estimator. Their repeated **20/22**
synthetic result refers to the same historical detector, including two strict
relative-key cases that returned inconclusive. Later key changes need their own
results; old passing interface tests do not establish musical accuracy.

Several milestones were checked in an unpacked Windows application. That is
different from running an installer and testing an installed release. Each linked
verification note retains its original scope and unresolved failures.
