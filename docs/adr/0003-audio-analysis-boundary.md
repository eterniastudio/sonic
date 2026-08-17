# ADR 0003: Audio Analysis Boundary

**Date:** 2026-01-01  
**Status:** Proposed  
**Context:** Sonic v0.4.0 — Audio Intelligence

## Problem Statement

Sonic v0.2 explicitly states: "it currently parses declared text and embedded tags; it does not derive BPM, key, or tuning from the waveform."

Producers need audio-derived analysis (BPM, key, loudness) for:
- Verifying declared metadata accuracy
- Discovering compatible beats
- Quality control (clipping, silence, loudness standards)
- Archive organization

However, blindly overwriting user-provided metadata with algorithmic guesses would:
- Violate user trust and creative intent
- Introduce errors from imperfect analysis
- Create confusion about which values are "correct"
- Make results non-reproducible across analyzer versions

## Decision

Implement a **layered evidence model** where audio analysis exists as a separate evidence category that never silently overwrites final user values.

### Evidence Categories

```typescript
type MetadataEvidence = {
  // User-declared from source (YouTube description, etc.)
  declared: MusicMetadata;
  
  // Embedded ID3/vorbis tags from audio file
  embedded: MusicMetadata;
  
  // Algorithmically derived from waveform
  analyzed: AudioAnalysis | null;
  
  // System suggestions based on confidence/conflict resolution
  suggested: MusicMetadata;
  
  // User's final authoritative values
  final: FinalMetadata;
};
```

### Audio Analysis Schema

```json
{
  "audioAnalysis": {
    "sourceSha256": "abc123...",
    "analyzerVersion": "1",
    "analyzedAtMs": 1735689600000,
    "bpm": {
      "primary": 144,
      "alternates": [72, 288],
      "confidence": 0.91
    },
    "key": {
      "primary": "F# minor",
      "camelot": "11A",
      "alternates": ["A major"],
      "confidence": 0.74
    },
    "tuning": {
      "detuneCents": -18.2,
      "referenceHz": 440,
      "confidence": 0.86
    },
    "loudness": {
      "integratedLufs": -10.8,
      "truePeakDbtp": -0.4,
      "lra": 8.2
    },
    "quality": {
      "hasClipping": false,
      "silenceStartMs": 0,
      "silenceEndMs": 120,
      "channels": 2,
      "sampleRateHz": 48000,
      "bitDepth": 24
    }
  }
}
```

### Behavioral Rules

1. **Analysis Never Overwrites Final Values**
   - User's `final` metadata is always authoritative
   - Analysis populates only the `analyzed` category
   - UI may show conflicts: "Declared: 140 BPM | Analyzed: 144 BPM (91% confidence)"

2. **Results Cached by Source SHA-256**
   ```rust
   fn get_or_analyze(source_hash: &str) -> AppResult<AudioAnalysis> {
       if let Some(cached) = db.find_analysis_by_hash(source_hash)? {
           return Ok(cached);
       }
       let result = run_analysis(&audio_path)?;
       db.cache_analysis(source_hash, &result)?;
       Ok(result)
   }
   ```

3. **Analyzer Version Tracked**
   - Store `analyzerVersion` with results
   - Mark results as "stale" when analyzer version changes
   - Offer "Re-analyze with latest" action

4. **Confidence Scores Required**
   - All derived values include confidence (0.0–1.0)
   - Low-confidence results (< 0.5) clearly labeled in UI
   - Thresholds configurable by user

5. **Batch Analysis as Background Job**
   ```rust
   enum AnalysisJobState {
       Queued,
       Running { current: usize, total: usize },
       Completed { analyzed: u32, skipped: u32, failed: u32 },
       Cancelled,
       Failed { error: String },
   }
   ```

6. **QC Before Musical Analysis**
   Phase 1 (deterministic, high-confidence):
   - LUFS loudness
   - True peak
   - Clipping detection
   - Silence boundaries
   - Duration, channels, sample rate, bit depth
   
   Phase 2 (algorithmic, variable confidence):
   - BPM estimation
   - Key detection
   - Tuning analysis
   - Beat grid

## Alternatives Considered

### Alternative 1: Auto-Update Final Metadata
**Rejected.** Silent overwriting violates user trust. Algorithmic errors would propagate.

### Alternative 2: Analysis Only on Demand
**Insufficient.** Users want batch processing for entire library. Background jobs required.

### Alternative 3: External Service API
**Rejected.** Privacy concerns, offline requirement, latency, cost. All analysis must be local.

### Alternative 4: Single Unified Score
**Insufficient.** Different algorithms have different confidence profiles. Per-field confidence required.

## Consequences

### Positive
- Clear separation of concerns
- User maintains creative control
- Reproducible results via versioning
- Transparent confidence communication
- Enables "smart suggestions" without coercion

### Negative
- More complex data model
- UI must display multiple metadata layers
- Storage overhead for analysis cache
- Requires careful UX to avoid confusion

### Risks
- Users may not understand evidence categories
- Low-confidence results might be misinterpreted as facts
- Performance impact of batch analysis
- Analyzer library licensing (GPL considerations)

## Implementation Notes

### Database Schema (v3)

```sql
CREATE TABLE audio_analysis_cache (
  id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL UNIQUE,
  analyzer_version INTEGER NOT NULL,
  analyzed_at_ms INTEGER NOT NULL,
  json TEXT NOT NULL CHECK (json_valid(json)),
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_analysis_hash ON audio_analysis_cache(source_sha256);

-- Add analyzed_metadata column to library_items
ALTER TABLE library_items ADD COLUMN analyzed_metadata_json TEXT;

-- Track analysis job state
CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  progress_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

### Analyzer Selection

Initial implementation should use:
- **LOUDNESS**: libebur128 or ffmpeg loudnorm filter
- **BPM/KEY**: Consider libraries like:
  - Mixxx Analyzer (GPL)
  - Essentia (AGPL)
  - Custom FFT-based implementation
  
**Licensing Note:** GPL/AGPL analyzers may require Sonic to adopt compatible license or isolate via process boundary.

### UI Requirements

1. **Inspector Panel:**
   - Show all four evidence categories
   - Highlight conflicts between declared vs. analyzed
   - "Apply analyzed value" button per field
   - Confidence indicator (color + percentage)

2. **Library View:**
   - Column: "Analyzed BPM" (separate from "BPM")
   - Filter: "Show low-confidence analysis only"
   - Smart collection: "Missing analysis"

3. **Settings:**
   - Toggle: "Auto-analyze new imports"
   - Slider: "Minimum confidence threshold"
   - Button: "Re-analyze entire library"
   - Display: Current analyzer version

## References

- Issue: `feat(analysis): add audio QC and musical analysis`
- Related: ADR 0004 (Sidecar as Source of Truth)
- [EBU R128 Standard](https://tech.ebu.ch/loudness)
- [Mixxx Analyzer Source](https://github.com/mixxxdj/mixxx)
