# Sonic metadata sidecar

Every Sonic export is paired with `.json/<audio-filename>.sonic.json` inside
the selected output directory. For example, `Track.wav` is paired with
`.json/Track.wav.sonic.json`. The sidecar is the portable producer record;
SQLite Library history is an optional local index and is not required to
understand the file. Sonic continues to read and import older sidecars stored
beside their audio.

## Schema version 2

```json
{
  "schemaVersion": 2,
  "sonicVersion": "0.2.3",
  "libraryItemId": "uuid",
  "jobId": "uuid",
  "clientItemId": "optional renderer correlation ID",
  "createdAtMs": 1784419200000,
  "source": {
    "kind": "youtube | soundcloud | localFile",
    "sourceFingerprint": "youtube:<provider-id> | soundcloud:<provider-id> | sha256:<hex>",
    "providerId": "optional provider ID",
    "canonicalUrl": "optional canonical provider URL",
    "fileName": "optional local basename",
    "originalPath": "optional full local source path"
  },
  "metadata": {
    "title": "Night Shift",
    "artist": "Producer",
    "bpm": 144,
    "alternateBpms": [72],
    "key": "F# minor",
    "camelot": "11A",
    "detuneCents": -31.8,
    "tuningHz": 432,
    "evidence": [],
    "warnings": []
  },
  "audioAnalysis": {
    "sourceSha256": "hex digest of analyzed source audio",
    "analyzerVersion": "sonic-tempo-1",
    "analyzedDurationMs": 145000,
    "bpm": { "primary": 144, "alternates": [72, 288], "confidence": 0.91 },
    "key": { "primary": "F# minor", "camelot": "11A", "confidence": 0.82 },
    "warnings": []
  },
  "inspectionAudio": {
    "container": "webm",
    "codec": "opus",
    "sampleRateHz": 48000,
    "channels": 2,
    "bitDepth": null,
    "durationMs": 145000,
    "fileSizeBytes": 4824100
  },
  "outputAudio": {
    "container": "mp3",
    "codec": "mp3",
    "sampleRateHz": 44100,
    "channels": 2,
    "bitDepth": null,
    "durationMs": 145000,
    "fileSizeBytes": 5800000
  },
  "export": {
    "presetId": "mp3Cbr320",
    "channelMode": "preserve",
    "normalizeLufs": null,
    "writeEmbeddedTags": true
  },
  "outputSha256": "hex digest of the published audio",
  "tagStatus": {
    "requested": true,
    "supported": true,
    "readbackVerified": true,
    "warnings": []
  }
}
```

Optional values serialize as JSON `null`; future schema versions may add new
optional fields. Readers should ignore unknown fields but reject a
`schemaVersion` they do not support when using the sidecar for destructive or
integrity-sensitive operations.

Schema version 2 records bounded local BPM/key analysis separately from the
producer-reviewed final metadata. `metadata.evidence` labels audio-derived
matches with `source: "audioAnalysis"`. Sonic continues to accept schema version
1, where `audioAnalysis` is absent, and rejects unknown future versions.

## Privacy

For a local source, `source.originalPath` is `null` unless **Include source
location in sidecar** is enabled in Settings. The basename and SHA-256 source
fingerprint remain available so the record can identify the input without
publishing its full directory structure.

YouTube and SoundCloud sidecars keep the canonical public URL and provider ID. Do not
share a sidecar when that URL itself is sensitive.

## Integrity and deletion

`outputSha256` describes the audio file, not the JSON sidecar. Sonic uses the
sidecar IDs and output hash together with the private Library record before an
explicit **Delete audio + sidecar** operation. If the audio or sidecar has been
changed, replaced, linked, or moved to an unsafe filesystem entry, Sonic
refuses the deletion.

The sidecar is written and synced in the isolated job workspace before Sonic
publishes the audio/sidecar pair with no-replace operations. A startup
publication journal recovers or safely removes a verified partial pair after
an interruption.
