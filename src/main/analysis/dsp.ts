/**
 * Sonic — self-contained audio-analysis DSP.
 *
 * Estimates tempo and key from PCM only. Tempo uses a half band-equalised
 * spectral-flux onset envelope, metrical-consistency scoring of periodicity
 * candidates and producer octave folding. Key detection uses interpolated
 * spectral peaks, tuning-corrected chroma and published Shaath profiles,
 * restricted to keys whose scale fits the chroma, with complete-triad
 * observations to corroborate relative-key decisions.
 *
 * Design constraints this file is written against:
 *  - Zero npm dependencies. The FFT below is our own radix-2 iterative
 *    Cooley–Tukey with precomputed twiddle factors; real frames are packed
 *    into a half-size complex transform.
 *  - No Node and no DOM imports. This module is pure computation, so it can be
 *    imported from a worker thread, from the main process, and from a plain
 *    Node script. The only imports are `shared/` siblings, which are themselves
 *    pure.
 *  - Deterministic: no randomness, no clock reads, no iteration over Maps keyed
 *    by non-deterministic values. The same `AnalysisInput` always yields
 *    byte-identical output.
 *  - Never throws, and never returns NaN/Infinity. Every public entry point
 *    funnels through a `try`/`catch` and every numeric field is guarded by
 *    `finiteOr`/`clamp01`.
 *
 * The relative import `../../shared/analysis` (rather than the `@shared/*`
 * alias) is deliberate: it is what makes the file loadable by a bare Node
 * script with no bundler alias configuration, while still resolving correctly
 * through the project's tsconfig `paths`.
 */

import {
  emptyKeyAnalysis,
  emptyTempoAnalysis,
  type FieldAnalysisStatus,
  type KeyAlternative,
  type KeyAnalysis,
  type TempoAlternative,
  type TempoAnalysis,
  type TempoRelation
} from '../../shared/analysis'
import { camelotFor } from '../../shared/music'

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

export interface AnalysisInput {
  /** Mono PCM, nominally -1..1, at `sampleRate`. */
  pcm: Float32Array
  sampleRate: number
  /** Duration of the full source file in seconds (may exceed pcm length if windowed). */
  sourceDurationSec: number
}

/* ------------------------------------------------------------------------- */
/* Tunable analysis constants                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Tempo front-end: FFT 1024 / hop 512 at 22050 Hz.
 *
 * Rationale for the frame geometry is expressed in *seconds* rather than bins
 * so that the same musical resolution survives a change of sample rate:
 *
 *   frame ≈ 46.4 ms, hop ≈ 23.2 ms → ≈ 43.07 frames/s at 22050 Hz
 *
 * 23.2 ms of time resolution is exactly what 300 BPM needs (one beat at 300 BPM
 * is 200 ms), and 46.4 ms frames still resolve a kick drum's attack without
 * smearing it into the next sixteenth note. The FFT size is rounded *up* to a
 * power of two and clipped to [256, 4096] so a 44.1/48 kHz source keeps the
 * same time resolution instead of silently halving it.
 */
const TEMPO_FRAME_SEC = 1024 / 22050
const TEMPO_HOP_SEC = 512 / 22050
const TEMPO_MIN_FFT = 256
const TEMPO_MAX_FFT = 4096

/**
 * Onset envelope de-trending window. ~2.3 s of moving mean at the nominal frame
 * rate: long enough that a whole bar of a loud chorus cannot raise the local
 * floor much, short enough to track a real dynamic change. This is what stops a
 * loud section from dominating the autocorrelation.
 */
const ONSET_TREND_SEC = 2.3

/**
 * Gaussian smoothing of the de-trended onset envelope, σ ≈ 1.5 frames at the
 * nominal 43 frames/s.
 *
 * A one-frame-wide onset turns the autocorrelation into a test of how often two
 * rounded onset positions happen to land a whole number of frames apart. For a
 * 140 BPM click (18.46 frames per beat) only ~54% of consecutive beats are 18
 * frames apart, while ~91% of beat pairs two periods apart are 37 frames apart,
 * so the half-tempo lag won purely through frame quantisation. A kernel a little
 * wider than one hop makes correlation a smooth function of lag, so a peak's
 * height no longer depends on where the true period falls between frames. It is
 * narrow compared with the shortest searched period (≈ 8.6 frames at 300 BPM),
 * so neighbouring pulses are not merged.
 */
const ONSET_SMOOTH_SEC = 0.035

/**
 * Period refinement integrates the autocorrelation at up to this many whole
 * multiples of the candidate period, evaluated at fractional lags. A period
 * error of δ frames becomes m·δ at the m-th multiple, so the longer lags
 * resolve the period far below one frame (≈ ±0.1 BPM at 174 BPM on a clean
 * 14 s excerpt) without changing which metrical level was chosen.
 */
const TEMPO_REFINE_MAX_MULTIPLES = 16
/** Refinement searches ±this fraction around the picked period. */
const TEMPO_REFINE_SPAN = 0.025

/**
 * Perceptual tempo *model* range, i.e. the range the returned numbers may live
 * in (and the range over which half/double alternatives are surfaced).
 */
const TEMPO_MODEL_MIN_BPM = 40
const TEMPO_MODEL_MAX_BPM = 300

/**
 * Internal search band for the PRIMARY decision: 60–200 BPM.
 *
 * Deliberately narrower than the model range. A 40–300 search invites the
 * classic failure where a 102 BPM track is reported as 204, because the
 * autocorrelation peak at 204 BPM (the eighth-note or hi-hat pulse) is often
 * *taller* than the beat-rate peak. Restricting the primary decision to 60–200
 * removes most of that failure mode before the prior even acts; readings outside
 * the band are still reachable — as the `half`/`double` alternatives of an
 * in-band primary, which is where they belong musically.
 */
const TEMPO_SEARCH_MIN_BPM = 60
const TEMPO_SEARCH_MAX_BPM = 200

/**
 * Tempo prior: Gaussian in LOG2-tempo space, centre 120 BPM, σ = 0.8 octaves.
 * Evaluated on the BPM ratio, so it is a log-normal prior on tempo.
 *
 * Source for the shape/width: the tempo-prior term from D. P. W. Ellis, "Beat
 * Tracking by Dynamic Programming", Journal of New Music Research 36(1), 2007,
 * which models log-tempo as Gaussian around a preferred tempo; the preferred
 * tempo itself (~120 BPM) comes from the tapping literature it rests on
 * (Fraisse 1982; Parncutt 1994). σ = 0.8 octaves is deliberately wide: this is
 * a tie-breaker between octave-related peaks, not a constraint, and it is
 * applied by *multiplication* so it can never invent a peak the signal lacks.
 */
const TEMPO_PRIOR_CENTRE_BPM = 120
const TEMPO_PRIOR_SIGMA_OCTAVES = 0.8

/**
 * Octave suppression: once a peak is picked, peaks within ±5 % of *that* BPM
 * are suppressed as the same reading and peaks at 0.5× / 2.0× are treated as
 * the `half` / `double` alternatives rather than as independent tempi.
 */
const TEMPO_SUPPRESS_RATIO = 0.05
/** Relative window searched for a competing half/double reading. */
const TEMPO_OCTAVE_WINDOW_RATIO = 0.06
/** A peak must reach this normalised periodicity to be a candidate at all. */
const TEMPO_MIN_PEAK = 0.1

/** Minimum local prominence, unless raw periodic correlation is strong (0.4).
 * Applied after stationary-signal and absolute-correlation evidence gates. */
const TEMPO_MIN_CONFIDENCE = 0.45

/**
 * Comb-filter periodicity (Scheirer, "Tempo and beat analysis of acoustic
 * musical signals", JASA 104(1), 1998): a bank of resonators, one per candidate
 * period, each summing the onset envelope over a comb of that period. It is
 * cheap (~nFrames × nPeriods adds) and phase-insensitive, which is exactly why
 * it is a useful *independent* view of the same evidence.
 *
 * Cross-check policy: when the comb bank and the autocorrelation agree on the
 * primary tempo to within this fraction, the reading is corroborated and
 * confidence is left alone. When they disagree, the peak is real but ambiguous:
 * confidence is scaled down (see `TEMPO_DISAGREE_CONFIDENCE_SCALE`) and the
 * disagreement is stated in `warning`. Neither method silently overrides the
 * other.
 */
const TEMPO_COMB_MIN_HARMONICS = 1
const TEMPO_COMB_MAX_HARMONICS = 8
/**
 * Accent bands for the octave check: below 200 Hz (kick and bass bodies),
 * 200 Hz – 2.5 kHz, and above 2.5 kHz (hats and noise bursts). Bands holding
 * less than 10% of the onset energy are ignored as carrying no accent evidence.
 */
const TEMPO_ACCENT_BAND_EDGES_HZ = [200, 2500] as const
const TEMPO_ACCENT_MIN_BAND_SHARE = 0.1
/** Periods folded together before coherence is pooled across segments. */
const TEMPO_COMB_SEGMENT_CYCLES = 4
const TEMPO_AGREEMENT_TOLERANCE = 0.03
const TEMPO_DISAGREE_CONFIDENCE_SCALE = 0.6
/**
 * "As periodic as" for the 3:2 grouping rule and the octave accent check: a
 * faster reading keeps at least 90% of the slower reading's correlation. Set
 * before the synthetic tempo matrix (scripts/benchmark-tempo.mjs) was run, not
 * fitted to it.
 */
const TEMPO_DUPLE_SUPPORT_RATIO = 0.9

/**
 * Band equalisation of the onset envelope (sonic-dsp/5). The full-band flux is
 * dominated by whichever band has the most bins changing — usually hats and
 * noise above 2.5 kHz — so a kick-every-beat house groove with open off-beat
 * hats read as 3:2 (81 BPM for 122). Half of the envelope is now the plain
 * flux and half the three accent bands rescaled to equal mean onset energy;
 * bands holding under 5% of the flux are left out of the equalised half so an
 * empty band is not amplified into noise. Half, rather than full, equalisation
 * keeps the triple-meter controls (3/4 at 180, 6/8 at 60) correct.
 */
const TEMPO_BAND_EQUALISATION = 0.5
const TEMPO_BAND_EQUALISATION_MIN_SHARE = 0.05

/**
 * Metrical consistency (sonic-dsp/5). A beat repeats at its own period *and*
 * at whole multiples of it (half bar, bar); a 3:2 or 4:3 cross-rhythm pulse,
 * such as the dotted-eighth of a tresillo or an afrobeats 3+3+2 figure, does
 * not. Candidates are scored by the mean fractional autocorrelation at 1–4
 * periods (multiples kept within half the envelope), searched ±2% around the
 * peak because peak positions are only frame-accurate, times the tempo prior.
 * The 2× and ½× of every periodicity peak are candidates too: an afrobeats
 * groove has no autocorrelation peak at its beat at all, only at its half bar.
 */
const TEMPO_METRIC_MULTIPLES = 4
const TEMPO_METRIC_SEARCH = 0.02
const TEMPO_OCTAVE_CANDIDATE_TOLERANCE = 0.01

/**
 * Producer octave folding (sonic-dsp/5). Trap and drill are labelled at the
 * hi-hat-driven 130–165 BPM rate even though the snare lands once per bar,
 * which the plain prior read as 65–82 BPM. A slow reading S is folded to 2S
 * when 2S ≤ 165 BPM and either (a) some accent band repeats at a subdivision
 * of 2S (half or third of its period, autocorrelation ≥ 0.15), or (b) S is
 * below 83 BPM and some band pulses at 2S (autocorrelation ≥ 0.2). A lo-fi
 * groove at 72 has no hat pulse at 144 (its band correlation there is
 * negative) and stays at 72; boom bap at 85–95 doubles past 165 and stays.
 * The other octave remains a reported alternative either way.
 */
const TEMPO_FOLD_MAX_BPM = 165
const TEMPO_FOLD_SLOW_BELOW_BPM = 83
const TEMPO_FOLD_SUBDIVISION_SUPPORT = 0.15
const TEMPO_FOLD_PULSE_SUPPORT = 0.2

/**
 * Evidence thresholds for `status: 'inconclusive'`.
 *
 *  - 6 s of audio: below this there are not enough beats to distinguish a
 *    tempo from a coincidence. (Also ≈ 4 bars at 120 BPM.)
 *  - 4 s of *envelope* and 8 lag-window cycles: the autocorrelation of a short
 *    envelope is dominated by its own length.
 *  - 0.1 linear correlation at the winning peak: essentially no periodicity.
 */
const TEMPO_MIN_AUDIO_SEC = 6
const TEMPO_MIN_ENVELOPE_SEC = 4
const TEMPO_MIN_CYCLES = 8

/**
 * Key front-end: window length is fixed in *seconds* and the FFT size is the
 * next power of two, clipped to [4096, 32768].
 *
 *   KEY_WINDOW_SEC ≈ 0.3715 s → 8192 samples at 22050 Hz → 2.69 Hz/bin
 *
 * Why: pitch content needs fine low-frequency resolution (a semitone at C3 is
 * ~7.8 Hz), while the analysis wants a steady number of frames per second at
 * any sample rate. Scaling the window by *time* keeps the bin width
 * proportional to `sampleRate`, which is exactly the documented behaviour:
 *
 *   22050 Hz (the expected rate — ffmpeg decodes to 22050 Hz mono) → 8192 pt → 2.69 Hz/bin
 *   44100 Hz                                                      → 16384 pt → 2.69 Hz/bin
 *   48000 Hz                                                      → 16384 pt → 2.93 Hz/bin
 *   96000 Hz                                                      → 32768 pt → 2.93 Hz/bin
 *
 * i.e. bin width stays at or below ~3 Hz — comfortably inside the "≤ 4 Hz" goal
 * — at the cost of a slightly coarser time resolution than the tempo front-end,
 * which is the right trade for chroma. Note that doubling to 16384 at 22050 Hz
 * would give 1.35 Hz/bin: better in principle, but it halves the number of
 * frames for a fixed window length and costs 2× the FFT work for a resolution
 * the peak interpolation below does not actually need, because partials are
 * resolved by peak-picking rather than by bin index.
 */
const KEY_WINDOW_SEC = 8192 / 22050
const KEY_MIN_FFT = 4096
const KEY_MAX_FFT = 32768

/** Fraction of a window advanced per key frame (~0.186 s). */
const KEY_HOP_RATIO = 0.5

/**
 * Fine pitch histogram resolution: 100 bins per semitone = 1 cent per bin.
 * Sub-bin interpolation keeps tuning shifts visible without quantizing pitches.
 */
const TUNING_BINS_PER_SEMITONE = 100
const TUNING_FINE_BINS = 12 * TUNING_BINS_PER_SEMITONE
const TUNING_SEARCH_CENTS = 50
const TUNING_STEP_CENTS = 1

/**
 * Register used for chroma accumulation.
 *
 * The lower bound keeps DC and rumble out. The upper bound matters: above
 * roughly 3 kHz a mix is dense with high harmonics that carry little tonal
 * information, and including them dilutes the profile toward uniform.
 */
const CHROMA_MIN_HZ = 55
const CHROMA_MAX_HZ = 3000
const KEY_PEAK_RELATIVE_FLOOR = 0.025
const KEY_PEAK_MIN_CONTRAST = 2
const KEY_PEAK_NEIGHBOUR_RADIUS = 6

/** Key analysis only ever looks at the first 90 s (mtime/clock independent). */
const KEY_MAX_SECONDS = 90

/**
 * `inconclusive` thresholds for key.
 *
 *  - 8 s of audio and ≥ 8 usable frames: fewer frames than that and the chroma
 *    is really a single chord, not a key.
 *  - Chroma total energy ≤ 1e-6, or chroma variance ≤ 1e-9: the chroma is
 *    numerically dead. This is checked *before* any correlation is trusted,
 *    because Pearson correlation on a zero-variance vector returns 0 by
 *    construction — which would otherwise look identical to a legitimate
 *    "no correlation" result.
 *  - Chroma entropy > 0.93 (Shannon entropy over the 12 L1-normalised bins,
 *    divided by ln 12). A clean tonal piece usually sits around 0.80–0.90;
 *    white noise sits at ~0.999 and a flat/percussive chroma near 1.0. 0.93 is
 *    the point where the profile has essentially no shape left for K–S to
 *    correlate against.
 *  - Best Pearson correlation < 0.35 absolute. Krumhansl–Kessler correlations
 *    for real tonal music are typically 0.6–0.9; 0.35 keeps a clearly tonal but
 *    noisy mix while rejecting a flat histogram.
 *
 * These are deliberately conservative: each one is a case where reporting a key
 * would be a fabrication rather than an estimate, and the brief for this module
 * is that a confident wrong answer is worse than an honest "no".
 */
const KEY_MIN_AUDIO_SEC = 8
const KEY_MIN_FRAMES = 8
const KEY_MIN_CHROMA_ENERGY = 1e-6
const KEY_MIN_CHROMA_VARIANCE = 1e-9
const KEY_MAX_ENTROPY = 0.93

/**
 * Lower bound on chroma entropy.
 *
 * `KEY_MAX_ENTROPY` catches material that is too flat, but the opposite failure
 * is just as real and was not caught at all: a single sustained pitch (a test
 * tone, a drone, a sub-bass note on its own) produces a maximally *peaked* chroma
 * with near-zero entropy, which then correlates well with whichever profile
 * rotation happens to align. That is exactly the "loudest frequency mistaken for
 * the key" error. A real key needs several distinct pitch classes present; a
 * three-note triad alone already sits near 0.44, so this floor rejects only
 * genuinely single-pitch material.
 */
const KEY_MIN_ENTROPY = 0.3
const KEY_MIN_CORRELATION = 0.35

/**
 * A relative major/minor is pushed into `alternatives` when it is within this
 * margin of the winner's correlation. It is nearly always in contention anyway;
 * the margin only decides whether it displaces a weaker candidate that the raw
 * ranking preferred.
 */
const KEY_RELATIVE_SURFACE_MARGIN = 0.15

/**
 * Key-signature fit (sonic-dsp/5). Profile correlation alone let a loop that
 * leans on its flat-seventh chord (Am–G–F–G) read as G major even though F♯,
 * G major's leading tone, was absent and F♮ was strong. A key may now lead
 * only if the chroma mass on its scale (natural or harmonic minor for minor
 * keys) is within 0.04 of the best-fitting scale; otherwise the next eligible
 * key leads and the excluded one stays visible as an alternative.
 */
const KEY_SCALE_FIT_MARGIN = 0.04
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const
const NATURAL_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] as const
const HARMONIC_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 11] as const

/**
 * Scale residual gate (sonic-dsp/5). With the strongest pitch class removed,
 * tonal material still concentrates on a 7-note scale; percussion whose only
 * pitched content is a kick's pitch sweep is near the 7/11 ≈ 0.64 chance level
 * (0.66 on the drums-only fixture). Below 0.68 the key is inconclusive. The
 * lowest value on the 28 GuitarSet recordings was 0.70.
 */
const KEY_MIN_SCALE_RESIDUAL = 0.68

/** How many alternatives each field reports at most. */
const TEMPO_MAX_ALTERNATIVES = 4
const KEY_MAX_ALTERNATIVES = 3

/**
 * Shaath's published popular-music profiles (index 0 = tonic), a revision of
 * Krumhansl–Kessler that gives the minor subtonic appropriate weight for natural
 * minor loops. Values are fixed research data, not trained on our fixtures.
 * Source: https://www.ibrahimshaath.co.uk/keyfinder/KeyFinder.pdf
 * Reproduced under "Shaath" in Essentia's key.cpp profile tables:
 * https://github.com/MTG/essentia/blob/master/src/algorithms/tonal/key.cpp
 * No Essentia or KeyFinder implementation code is included or required.
 */
const KEY_MAJOR_PROFILE = [
  6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4
] as const
const KEY_MINOR_PROFILE = [
  6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2
] as const

/** Sharp spellings only — `shared/music` normalises the same way. */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/* ------------------------------------------------------------------------- */
/* Numeric guards                                                             */
/* ------------------------------------------------------------------------- */

/** Coerces any non-finite number to `fallback`. Every returned number passes. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, lo: number, hi: number): number {
  const v = finiteOr(value, lo)
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** Display rounding to a step, with -0 normalised away. */
function roundToStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step
  return Object.is(rounded, -0) ? 0 : Number(finiteOr(rounded, 0).toFixed(6))
}

/* ------------------------------------------------------------------------- */
/* FFT — radix-2 iterative Cooley–Tukey, precomputed twiddles                  */
/* ------------------------------------------------------------------------- */

/**
 * In-place forward FFT on interleaved-format-free split arrays.
 *
 * Layout mirrors a classic "two real arrays" FFT: callers pass `re` and `im`
 * separately. Real frames go through `RealFft` below, which packs them into a
 * half-size complex transform.
 *
 * Twiddle factors are precomputed once per size and cached on the instance, so
 * repeatedly transforming frames of the same length costs no extra setup.
 */
class Fft {
  readonly size: number
  private readonly levels: number
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array
  private readonly reverse: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${size}`)
    }
    this.size = size
    this.levels = Math.round(Math.log2(size))

    // cos/sin(-2*pi*k/n) for k in [0, n/2)
    this.cosTable = new Float64Array(size / 2)
    this.sinTable = new Float64Array(size / 2)
    for (let k = 0; k < size / 2; k += 1) {
      const angle = (-2 * Math.PI * k) / size
      this.cosTable[k] = Math.cos(angle)
      this.sinTable[k] = Math.sin(angle)
    }

    // Bit-reversal permutation, precomputed.
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i += 1) {
      let x = i
      let r = 0
      for (let b = 0; b < this.levels; b += 1) {
        r = (r << 1) | (x & 1)
        x >>>= 1
      }
      this.reverse[i] = r
    }
  }

  /**
   * Forward transform. `re`/`im` hold the complex input and are overwritten
   * with the complex output.
   */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size
    const rev = this.reverse

    for (let i = 0; i < n; i += 1) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }

    // Butterfly stages double the span each pass: 2, 4, 8, … n. That is
    // log2(n) stages. The body below relies on `span` being a power of two —
    // `half = span >> 1` and `step = n / span` are only the correct twiddle
    // stride for power-of-two spans, and `start += span` only lands on valid
    // sub-transform boundaries then. Incrementing by 1 instead would run n-1
    // stages, read past the end of the arrays (typed-array reads yield
    // `undefined` → NaN) and turn a 10-stage transform into a 1023-stage one.
    const cos = this.cosTable
    const sin = this.sinTable
    for (let span = 2; span <= n; span *= 2) {
      const half = span >> 1
      const step = n / span
      for (let start = 0; start < n; start += span) {
        for (let k = 0, tw = 0; k < half; k += 1, tw += step) {
          const wr = cos[tw]
          const wi = sin[tw]
          const a = start + k
          const b = a + half
          const br = re[b]
          const bi = im[b]
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

/**
 * Magnitude spectrum of a real frame through a half-size complex FFT
 * (sonic-dsp/5 performance change, numerically equivalent to a full-size
 * transform up to floating-point rounding).
 *
 * The N real samples are packed as N/2 complex values z[n] = x[2n] + i·x[2n+1],
 * transformed once, and split into even/odd spectra:
 *
 *   E[k] = (Z[k] + conj Z[M−k]) / 2,   O[k] = (Z[k] − conj Z[M−k]) / 2i,
 *   X[k] = E[k] + e^{−2πik/N} · O[k],  M = N/2, Z[M] ≡ Z[0].
 *
 * Both analysers need only |X[k]|, so the transform costs about half of the
 * previous full-size complex FFT of zero-imaginary input, with no allocation
 * per frame.
 */
class RealFft {
  readonly size: number
  private readonly half: Fft
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) {
      throw new Error(`Real FFT size must be a power of two >= 4, got ${size}`)
    }
    this.size = size
    const m = size >> 1
    this.half = new Fft(m)
    this.re = new Float64Array(m)
    this.im = new Float64Array(m)
    this.cos = new Float64Array(m + 1)
    this.sin = new Float64Array(m + 1)
    for (let k = 0; k <= m; k += 1) {
      const angle = (2 * Math.PI * k) / size
      this.cos[k] = Math.cos(angle)
      this.sin[k] = Math.sin(angle)
    }
  }

  /**
   * Writes |X[k]| for k = 0..count−1 (count ≤ N/2 + 1) of `pcm[offset..]`
   * multiplied by `window` into `out`.
   */
  magnitudes(pcm: Float32Array, offset: number, window: Float64Array, out: Float64Array, count: number): void {
    const m = this.size >> 1
    const re = this.re
    const im = this.im
    for (let n = 0, i = offset; n < m; n += 1, i += 2) {
      re[n] = pcm[i] * window[2 * n]
      im[n] = pcm[i + 1] * window[2 * n + 1]
    }
    this.half.forward(re, im)
    const limit = Math.min(count, m + 1)
    for (let k = 0; k < limit; k += 1) {
      const a = k === m ? 0 : k
      const b = k === 0 ? 0 : m - k
      const zr = re[a]
      const zi = im[a]
      const cr = re[b]
      const ci = -im[b]
      const er = 0.5 * (zr + cr)
      const ei = 0.5 * (zi + ci)
      const or = 0.5 * (zi - ci)
      const oi = -0.5 * (zr - cr)
      // e^{−iθ} · O = (cos θ − i sin θ)(or + i oi)
      const c = this.cos[k]
      const sn = this.sin[k]
      const xr = er + c * or + sn * oi
      const xi = ei + c * oi - sn * or
      out[k] = Math.sqrt(xr * xr + xi * xi)
    }
  }
}

/** Periodic Hann window (denominator N, not N-1) — the correct choice for STFT. */
function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  }
  return w
}

/** Next power of two ≥ n, clipped into [lo, hi]. */
function fftSizeFor(n: number, lo: number, hi: number): number {
  let size = lo
  while (size < n && size < hi) size *= 2
  return clamp(size, lo, hi)
}

/**
 * Replaces non-finite samples (NaN, ±Infinity) with silence.
 *
 * A single NaN would otherwise make the whole-buffer RMS NaN, and the silence
 * guard would then report an entire track as silent; it would also poison
 * every FFT frame it touches. Finite input is returned untouched (no copy).
 * The PCM is read exactly once.
 */
function sanitizeInput(input: AnalysisInput): { input: AnalysisInput; replaced: number } {
  const pcm = input.pcm
  if (!pcm || typeof pcm.length !== 'number') return { input, replaced: 0 }
  let firstBad = -1
  for (let i = 0; i < pcm.length; i += 1) {
    if (!Number.isFinite(pcm[i])) { firstBad = i; break }
  }
  const base = { pcm, sampleRate: input.sampleRate, sourceDurationSec: input.sourceDurationSec }
  if (firstBad < 0) return { input: base, replaced: 0 }
  const clean = new Float32Array(pcm)
  let replaced = 0
  for (let i = firstBad; i < clean.length; i += 1) {
    if (!Number.isFinite(clean[i])) { clean[i] = 0; replaced += 1 }
  }
  return { input: { ...base, pcm: clean }, replaced }
}

/** Appends a note about replaced samples to a field result's warning. */
function noteReplacedSamples<T extends { warning: string | null }>(result: T, replaced: number): T {
  if (replaced === 0) return result
  const note = `${replaced} non-finite audio sample${replaced === 1 ? ' was' : 's were'} treated as silence.`
  return { ...result, warning: result.warning ? `${result.warning} ${note}` : note }
}

/** Root-mean-square of a span. */
function rms(pcm: Float32Array, from: number, to: number): number {
  const n = to - from
  if (n <= 0) return 0
  let sum = 0
  for (let i = from; i < to; i += 1) {
    const s = pcm[i]
    sum += s * s
  }
  const value = Math.sqrt(sum / n)
  return Number.isFinite(value) ? value : 0
}

/* ------------------------------------------------------------------------- */
/* estimateTempo                                                              */
/* ------------------------------------------------------------------------- */

/** A candidate peak in the (prior-weighted) periodicity curve. */
interface TempoPeak {
  bpm: number
  /** Prior-weighted periodicity value at the peak. */
  strength: number
  /** Raw (un-weighted, un-prior-ed) periodicity at the peak. */
  raw: number
  /** Comb-filter response at the peak's period, for the agreement cross-check. */
  comb: number
}

/** Normalises a curve to its own maximum, in place-safe fashion (returns a copy). */
function normaliseToMax(curve: Float64Array): Float64Array {
  let max = 0
  for (let i = 0; i < curve.length; i += 1) {
    const v = curve[i]
    if (v > max) max = v
  }
  const out = new Float64Array(curve.length)
  if (max > 1e-12) {
    for (let i = 0; i < curve.length; i += 1) out[i] = curve[i] / max
  }
  return out
}

/**
 * Estimates tempo from the audio signal alone.
 *
 * Pipeline: Hann-windowed STFT → half-wave-rectified log-magnitude spectral
 * flux, half band-equalised (onset strength) → moving-mean de-trending →
 * Gaussian smoothing → two periodicity views of the same envelope (Pearson
 * autocorrelation and a segmented Scheirer-style comb bank) → peak picking on
 * the combined curve, plus each peak's 2× and ½× → candidates scored by
 * metrical consistency (mean correlation at 1–4 periods) × log-normal tempo
 * prior → decision inside the 60–200 BPM band → 3:2 grouping and octave-accent
 * checks → producer octave folding into ≤165 BPM → fractional multi-period
 * refinement → half/double reporting with octave suppression.
 *
 * Never throws; returns `status: 'inconclusive'` with a `warning` whenever the
 * signal does not carry enough rhythmic evidence.
 */
export function estimateTempo(input: AnalysisInput): TempoAnalysis {
  try {
    const sanitized = sanitizeInput(input)
    return noteReplacedSamples(estimateTempoInner(sanitized.input), sanitized.replaced)
  } catch {
    const failed = emptyTempoAnalysis()
    return { ...failed, status: 'failed', warning: 'Tempo analysis failed unexpectedly.' }
  }
}

function estimateTempoInner(input: AnalysisInput): TempoAnalysis {
  const pcm = input.pcm
  const sampleRate = Math.floor(finiteOr(input.sampleRate, 0))
  const samples = pcm && typeof pcm.length === 'number' ? pcm.length : 0

  if (samples === 0) {
    return inconclusiveTempo('No audio samples were available to analyse.')
  }
  if (sampleRate <= 0) {
    return inconclusiveTempo('The sample rate was invalid, so tempo could not be estimated.')
  }

  const seconds = samples / sampleRate

  // ---- silence / no-signal guard ----------------------------------------
  // A cheap time-domain RMS check up front: an all-zero or near-zero buffer is
  // silence by definition, and we should not let numerical dust in the FFT
  // produce a confident-looking tempo.
  const level = rms(pcm, 0, samples)
  if (!(level > 1e-6)) {
    return inconclusiveTempo('The audio is silent, so no tempo could be estimated.')
  }

  // ---- frame geometry ----------------------------------------------------
  const fftSize = fftSizeFor(
    Math.max(2, Math.round(TEMPO_FRAME_SEC * sampleRate)),
    TEMPO_MIN_FFT,
    TEMPO_MAX_FFT
  )
  const hop = Math.max(1, Math.round(TEMPO_HOP_SEC * sampleRate))
  const bins = fftSize >> 1
  const frames = samples >= fftSize ? 1 + Math.floor((samples - fftSize) / hop) : 0
  const framesPerSecond = sampleRate / hop

  if (frames < 2) {
    return inconclusiveTempo(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${TEMPO_MIN_AUDIO_SEC} s is needed to measure a tempo.`
    )
  }

  // ---- onset strength envelope (spectral flux) ---------------------------
  const flux = spectralFluxEnvelope(pcm, fftSize, hop, frames, bins, level, sampleRate)
  const fullEnvelope = flux.envelope
  if (fullEnvelope.reduce((sum, value) => sum + value, 0) / frames < 0.02) {
    return inconclusiveTempo('The spectrum was stationary; changes were too small to establish rhythmic onsets.')
  }
  const envelopeSeconds = frames / framesPerSecond

  if (envelopeSeconds < TEMPO_MIN_ENVELOPE_SEC || seconds < TEMPO_MIN_AUDIO_SEC) {
    return inconclusiveTempo(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${TEMPO_MIN_AUDIO_SEC} s is needed to measure a tempo.`
    )
  }

  // ---- leading-silence trim ----------------------------------------------
  // A silent intro would otherwise contribute a long run of zero onset strength,
  // which biases the moving mean at the start and inflates short-lag
  // correlations that merely match "silence to silence". Only a *substantial*
  // leading run is trimmed, and never enough to drop below the minimum
  // evidence length, so a quiet-but-real opening is left alone.
  const envelope = trimLeadingSilence(
    fullEnvelope,
    framesPerSecond,
    TEMPO_MIN_ENVELOPE_SEC
  )

  // De-trend: subtract a moving mean so a loud section cannot dominate, then
  // scale by the mean absolute deviation so the result is level-independent.
  const detrended = gaussianSmooth(detrendEnvelope(envelope, framesPerSecond), ONSET_SMOOTH_SEC * framesPerSecond)
  const frameCount = detrended.length

  let energy = 0
  for (let i = 0; i < frameCount; i += 1) energy += detrended[i]
  if (!(energy > 1e-9)) {
    return inconclusiveTempo('The onset envelope was flat, so no rhythmic periodicity was found.')
  }

  // ---- lag range ---------------------------------------------------------
  // The curve is built over the full 40–300 model range so that out-of-band
  // readings remain available as evidence; the *decision* is confined to
  // 60–200 below.
  const minBpm = TEMPO_MODEL_MIN_BPM
  const maxBpm = Math.min(TEMPO_MODEL_MAX_BPM, framesPerSecond * 60)
  if (!(maxBpm > minBpm)) {
    return inconclusiveTempo('The audio was too short to search the 40–300 BPM range.')
  }

  const lagMin = Math.max(2, Math.floor((framesPerSecond * 60) / maxBpm))
  let lagMax = Math.ceil((framesPerSecond * 60) / minBpm)
  if (lagMax > frameCount - 4) lagMax = frameCount - 4
  if (lagMax - lagMin < 4) {
    return inconclusiveTempo('The audio was too short for a reliable autocorrelation of the beat.')
  }

  // Require enough repetitions of the *slowest* searched period to actually
  // observe a pulse: with fewer than TEMPO_MIN_CYCLES cycles of the longest
  // lag present in the envelope, the correlation is measuring the envelope's
  // own length rather than any periodicity in the audio.
  const cycles = (frameCount - lagMax) / lagMax
  if (frameCount - lagMax < TEMPO_MIN_CYCLES || cycles < 1) {
    return inconclusiveTempo(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${TEMPO_MIN_AUDIO_SEC} s is needed to measure a tempo.`
    )
  }

  // ---- periodicity views -------------------------------------------------
  const acSize = lagMax + 1
  const autocorrelation = new Float64Array(acSize)
  const comb = new Float64Array(acSize)

  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    autocorrelation[lag] = normalisedAutocorrelation(detrended, frameCount, lag)
  }
  if (Math.max(...autocorrelation) < 0.25) {
    return inconclusiveTempo('No repeating onset pattern had sufficient correlation to establish a tempo.')
  }
  const combLagMax = Math.min(lagMax, Math.floor(frameCount / TEMPO_COMB_MAX_HARMONICS))
  for (let lag = lagMin; lag <= combLagMax; lag += 1) {
    comb[lag] = combFilterResponse(detrended, frameCount, lag)
  }

  // ---- peak picking (decision band) --------------------------------------
  const decisionMin = TEMPO_SEARCH_MIN_BPM
  const decisionMax = TEMPO_SEARCH_MAX_BPM

  // Band envelopes for the octave accent check, built once on first use. Only
  // bands carrying at least TEMPO_ACCENT_MIN_BAND_SHARE of the raw onset
  // energy take part; a nearly empty band carries no accent evidence.
  let accentBands: Float64Array[] | null = null
  const octaveIsAccentless = (bpm: number): boolean => {
    if (!accentBands) {
      const trim = fullEnvelope.length - envelope.length
      const raw = flux.bands.map((band) => band.subarray(trim))
      const energies = raw.map((band) => band.reduce((sum, value) => sum + value, 0))
      const total = energies.reduce((sum, value) => sum + value, 0)
      accentBands = raw
        .filter((_, index) => total > 0 && energies[index] >= total * TEMPO_ACCENT_MIN_BAND_SHARE)
        .map((band) => gaussianSmooth(detrendEnvelope(band, framesPerSecond), ONSET_SMOOTH_SEC * framesPerSecond))
    }
    return accentlessOctave(accentBands, (framesPerSecond * 60) / bpm)
  }
  const bandCorrelations = (lag: number): number[] => {
    if (!accentBands) octaveIsAccentless(TEMPO_SEARCH_MIN_BPM)
    return (accentBands ?? []).map((band) => fractionalAutocorrelation(band, band.length, lag))
  }
  const foldsToDouble = (slow: number, fast: number): boolean => {
    const period = (framesPerSecond * 60) / fast
    const subdivision = Math.max(-1, ...bandCorrelations(period / 2), ...bandCorrelations(period / 3))
    if (subdivision >= TEMPO_FOLD_SUBDIVISION_SUPPORT) return true
    return slow < TEMPO_FOLD_SLOW_BELOW_BPM && Math.max(-1, ...bandCorrelations(period)) >= TEMPO_FOLD_PULSE_SUPPORT
  }
  // Each method is peak-picked independently first, because the agreement
  // cross-check must compare like with like: each view's own tempo under the
  // same decision rules as the primary (prior-weighted inside the 60–200 BPM
  // decision band, then the grouping and octave-accent checks). Unbounded
  // picks over 40–300 named a different metrical level from the primary on
  // almost every metronomic input, so the cross-check measured the search
  // range rather than any disagreement between the methods.
  const acBpm = viewReading(autocorrelation, lagMin, lagMax, framesPerSecond, decisionMin, decisionMax, octaveIsAccentless)
  const combBpm = viewReading(comb, lagMin, combLagMax, framesPerSecond, decisionMin, decisionMax, octaveIsAccentless)

  // Combining the two normalised views keeps the agreement
  // information in the curve itself: a period both methods like is reinforced,
  // a period only one method likes still survives on its own merit.
  const acNorm = normaliseToMax(autocorrelation)
  const combNorm = normaliseToMax(comb)
  const combined = new Float64Array(acSize)
  const weighted = new Float64Array(acSize)
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    // Phase folding is sensitive to accumulated integer-period error; use it
    // as corroboration, not an equal vote capable of moving the pulse rate.
    const value = acNorm[lag] + 0.25 * combNorm[lag]
    combined[lag] = value
    const bpm = (framesPerSecond * 60) / lag
    weighted[lag] = value * tempoPrior(bpm)
  }

  const peaks: TempoPeak[] = []
  for (let lag = lagMin + 1; lag < lagMax; lag += 1) {
    const value = weighted[lag]
    if (value < TEMPO_MIN_PEAK) continue
    if (value < weighted[lag - 1] || value < weighted[lag + 1]) continue
    const bpm = (framesPerSecond * 60) / lag
    if (!(bpm >= minBpm && bpm <= maxBpm)) continue
    const refined = parabolicLag(weighted, lag, lagMin, lagMax)
    const refinedBpm = (framesPerSecond * 60) / refined
    if (!(refinedBpm >= minBpm && refinedBpm <= maxBpm)) continue
    const strength = Math.max(0, interpolateAt(weighted, refined))
    const raw = Math.max(0, interpolateAt(combined, refined))
    if (raw < TEMPO_MIN_PEAK) continue
    peaks.push({
      bpm: refinedBpm,
      strength,
      raw,
      comb: Math.max(0, combNorm[lag])
    })
  }

  // ---- metrical consistency ---------------------------------------------
  // See TEMPO_METRIC_MULTIPLES. Every candidate, including the 2× and ½× of
  // each periodicity peak, is scored by how well its period repeats at its
  // whole multiples, times the tempo prior.
  const metricAt = (period: number): number => {
    let total = 0
    let count = 0
    for (let k = 1; k <= TEMPO_METRIC_MULTIPLES; k += 1) {
      if (k * period > frameCount / 2) break
      total += fractionalAutocorrelation(detrended, frameCount, k * period)
      count += 1
    }
    return count > 0 ? Math.max(0, total / count) : 0
  }
  const metricCache = new Map<number, number>()
  const metricOf = (bpm: number): number => {
    const cached = metricCache.get(bpm)
    if (cached !== undefined) return cached
    const period = (framesPerSecond * 60) / bpm
    let best = 0
    for (let k = -4; k <= 4; k += 1) best = Math.max(best, metricAt(period * (1 + (k * TEMPO_METRIC_SEARCH) / 4)))
    metricCache.set(bpm, best)
    return best
  }
  for (const peak of [...peaks]) {
    for (const factor of [2, 0.5]) {
      const bpm = peak.bpm * factor
      if (!(bpm >= minBpm && bpm <= maxBpm)) continue
      if (peaks.some((other) => Math.abs(other.bpm / bpm - 1) < TEMPO_OCTAVE_CANDIDATE_TOLERANCE)) continue
      const lag = (framesPerSecond * 60) / bpm
      peaks.push({
        bpm,
        strength: 0,
        raw: Math.max(0, interpolateAt(combined, lag), metricOf(bpm)),
        comb: Math.max(0, interpolateAt(combNorm, lag))
      })
    }
  }
  for (const peak of peaks) peak.strength = tempoPrior(peak.bpm) * metricOf(peak.bpm)

  peaks.sort((a, b) => b.strength - a.strength || a.bpm - b.bpm)

  // The primary decision is restricted to the 60–200 BPM band (see
  // TEMPO_SEARCH_MIN_BPM for why). If no peak exists there, fall back to the
  // strongest peak in the full model range rather than declaring failure: the
  // material may genuinely be a 55 BPM ballad or a 210 BPM drum loop.
  const inBand = peaks.filter((peak) => peak.bpm >= decisionMin && peak.bpm <= decisionMax)
  let best = inBand.length > 0 ? inBand[0] : peaks[0]
  // Agreement on a repeating phrase can defeat a prior-favoured syncopation.
  // Retain ordinary duple/triple metrical choices; neither view establishes
  // the intended beat level merely by finding the same longer phrase.
  if (acBpm > 0 && Math.abs(acBpm / combBpm - 1) < TEMPO_AGREEMENT_TOLERANCE &&
      best && ![0.5, 1, 1.5, 2, 3, 4].some((ratio) => Math.abs(best.bpm / acBpm / ratio - 1) < 0.05)) {
    const corroborated = peaks.find((peak) => Math.abs(peak.bpm / acBpm - 1) < TEMPO_AGREEMENT_TOLERANCE)
    if (corroborated && best && metricOf(corroborated.bpm) > metricOf(best.bpm) * 1.4) best = corroborated
  }
  // Readings 3:2 apart are a choice of grouping, decided by periodicity rather
  // than by the tempo prior (see `resolveGrouping`).
  if (best && best.bpm >= decisionMin && best.bpm <= decisionMax) {
    const resolved = resolveGrouping(
      best.bpm,
      metricOf,
      (target) => inBand.find((peak) => Math.abs(peak.bpm / target - 1) < TEMPO_AGREEMENT_TOLERANCE)?.bpm ?? null
    )
    best = inBand.find((peak) => peak.bpm === resolved) ?? best
  }
  // Octave (2:1) choices are the prior's, with the other octave reported as an
  // alternative, and with one exception: a slower reading needs its beats to
  // differ from its off-beats somewhere in the spectrum. If the pulse at twice the pick is as periodic as the pick in
  // every band that carries onsets, nothing distinguishes the pick's beats
  // from its off-beats and the faster pulse is the beat. A kick on the beat
  // with a hat on the off-beat stays at the kick rate: the low band carries the
  // kick only on the beat.
  if (best && best.bpm >= decisionMin && best.bpm <= decisionMax) {
    const pick = best
    const faster = inBand.find((peak) => Math.abs(peak.bpm / pick.bpm / 2 - 1) < TEMPO_AGREEMENT_TOLERANCE)
    if (faster && octaveIsAccentless(pick.bpm)) best = faster
  }
  // Producer octave folding (see TEMPO_FOLD_MAX_BPM).
  if (best) {
    const slow = best.bpm
    const fast = slow * 2
    if (slow >= decisionMin && fast <= TEMPO_FOLD_MAX_BPM && foldsToDouble(slow, fast)) {
      const lag = (framesPerSecond * 60) / fast
      best = peaks.find((peak) => Math.abs(peak.bpm / fast - 1) < TEMPO_AGREEMENT_TOLERANCE) ??
        { bpm: fast, strength: 0, raw: Math.max(0, interpolateAt(combined, lag), metricOf(fast)), comb: 0 }
    }
  }

  if (!best) {
    return inconclusiveTempo('No periodic onset pattern stood out above the background.')
  }
  if (!(best.raw > TEMPO_MIN_PEAK)) {
    return inconclusiveTempo('The onset envelope had no clear periodic peak.')
  }

  // The comb, the tempo prior and the integer lag grid must not shift the
  // measured period. Refine against fractional-lag autocorrelation at whole
  // multiples of the chosen period; this sharpens the period without changing
  // the metrical level that was decided above.
  const refine = (bpm: number): number => clamp(
    refinePeriodFromMultiples(detrended, frameCount, bpm, framesPerSecond),
    minBpm,
    maxBpm
  )
  const bpmExact = refine(best.bpm)

  // ---- cross-check agreement ---------------------------------------------
  // Both periodicity methods should name the same pulse. They disagree when the
  // signal supports two readings that the two methods weight differently —
  // exactly the situation where confidence should not be high.
  const agreement = tempoAgreement(bpmExact, acBpm, combBpm)

  // ---- half / double reporting -------------------------------------------
  const alternatives: TempoAlternative[] = []
  const used: number[] = [bpmExact]

  const octaveTargets: { target: number; relation: TempoRelation }[] = [
    { target: bpmExact / 2, relation: 'half' },
    { target: bpmExact * 2, relation: 'double' }
  ]
  const octavePeaks: { peak: TempoPeak; relation: TempoRelation }[] = []
  let missingOctave = 0
  for (const { target, relation } of octaveTargets) {
    if (!(target >= minBpm && target <= maxBpm)) {
      missingOctave += 1
      continue
    }
    const tolerance = Math.max(1, target * TEMPO_OCTAVE_WINDOW_RATIO)
    const found = strongestPeakNear(peaks, target, tolerance, used)
    if (found) octavePeaks.push({ peak: found, relation })
    else missingOctave += 1
  }

  // Strongest octave reading first, as alternatives are ranked by strength.
  octavePeaks.sort((a, b) => b.peak.strength - a.peak.strength)
  for (const { peak, relation } of octavePeaks) {
    used.push(peak.bpm)
    alternatives.push({
      bpm: roundToStep(refine(peak.bpm), 0.1),
      relation,
      strength: finiteOr(peak.strength, 0)
    })
  }

  // Any other well-separated strong reading is reported as `other`. Octave
  // suppression (±TEMPO_SUPPRESS_RATIO) plus the half/double relation test is
  // what stops a single reading from being reported two or three times.
  for (const peak of [...peaks].sort((a, b) => b.raw - a.raw)) {
    if (alternatives.length >= TEMPO_MAX_ALTERNATIVES) break
    if (isSuppressed(peak.bpm, used)) continue
    used.push(peak.bpm)
    alternatives.push({
      bpm: roundToStep(refine(peak.bpm), 0.1),
      relation: 'other',
      strength: finiteOr(peak.strength, 0)
    })
  }

  // ---- confidence ---------------------------------------------------------
  // Prominence keeps its original scale: prior × combined periodicity at the
  // chosen period against the local median of the combined curve.
  const prominence = peakProminence(combined, lagMin, lagMax, framesPerSecond * 60, {
    ...best,
    strength: tempoPrior(best.bpm) * Math.max(0, interpolateAt(combined, (framesPerSecond * 60) / best.bpm))
  })
  const confidence = agreement.corroborated
    ? prominence
    : clamp01(prominence * TEMPO_DISAGREE_CONFIDENCE_SCALE)

  // Evidence and metrical agreement are separate. A repeating syncopation can
  // support a pulse even if the methods choose different metrical levels.
  // A repeating figure supports the pulse through its multiples, and a beat
  // that only shows up through its half bar (afrobeats, dembow) through the
  // slower octave; noise has neither.
  const rhythmicSupport = Math.max(
    interpolateAt(autocorrelation, framesPerSecond * 60 / bpmExact),
    metricOf(bpmExact),
    metricOf(bpmExact / 2)
  )
  if (!(prominence >= TEMPO_MIN_CONFIDENCE || rhythmicSupport >= 0.4)) {
    return inconclusiveTempo(
      'No clear rhythmic pulse stood out above the background, so no tempo was reported.'
    )
  }

  const warnings: string[] = []
  if (!agreement.corroborated) warnings.push(agreement.note)
  if (missingOctave === 2) {
    warnings.push('No supported half- or double-time alternative was found within 40–300 BPM.')
  }

  return {
    status: 'estimated',
    bpm: roundToStep(bpmExact, 0.1),
    bpmExact,
    alternatives,
    confidence,
    warning: warnings.length > 0 ? warnings.join(' ') : null
  }
}

/**
 * Drops a substantial leading run of near-zero onset strength.
 *
 * "Substantial" means at least 2 s of continuous near-silence at the head of the
 * envelope; the trim then keeps at least `keepSeconds` of envelope so the
 * autocorrelation still has evidence to work with. Returns the original array
 * when there is nothing worth trimming, so the common path allocates nothing.
 */
function trimLeadingSilence(
  envelope: Float64Array,
  framesPerSecond: number,
  keepSeconds: number
): Float64Array {
  const frames = envelope.length
  if (frames < 4) return envelope

  // Reference level: the median of the non-zero envelope values, so a track that
  // is simply quiet throughout is not mistaken for a track with a silent intro.
  const nonZero: number[] = []
  for (let i = 0; i < frames; i += 1) {
    if (envelope[i] > 0) nonZero.push(envelope[i])
  }
  if (nonZero.length < frames * 0.2) return envelope
  nonZero.sort((a, b) => a - b)
  const median = nonZero[nonZero.length >> 1]
  if (!(median > 1e-9)) return envelope

  const floor = median * 0.02
  const minSilentFrames = Math.round(2 * framesPerSecond)
  const keepFrames = Math.round(keepSeconds * framesPerSecond)

  let firstActive = 0
  while (firstActive < frames && envelope[firstActive] <= floor) firstActive += 1

  if (firstActive < minSilentFrames) return envelope
  if (frames - firstActive < keepFrames) {
    firstActive = Math.max(0, frames - keepFrames)
  }
  if (firstActive <= 0) return envelope
  return envelope.subarray(firstActive)
}

/**
 * Phase-folded periodic energy for one integer period. Coherent energy is
 * the squared phase sums divided by the number of complete cycles; dividing
 * by input energy gives a 0..1 concentration. This is a corroborating view of
 * the same onset evidence, not a statistically independent measurement.
 */
function combFilterResponse(envelope: Float64Array, frames: number, period: number): number {
  // Fold every phase over the complete excerpt, in consecutive segments of
  // TEMPO_COMB_SEGMENT_CYCLES periods. The old implementation sampled only the
  // first eight teeth anchored at sample zero, so an intro offset or a
  // syncopation could change the chosen tempo without changing the pulse.
  // Folding a whole 150 s excerpt at an integer period instead accumulates the
  // fractional period error (0.4 frame per beat is ~85 frames after 212
  // beats), so coherence is measured per segment and pooled. Normalize by the
  // energy of the same observations.
  if (!(period >= 2)) return 0
  const cycles = Math.floor(frames / period)
  if (cycles < TEMPO_COMB_MIN_HARMONICS) return 0
  const bins = Math.max(1, Math.round(period))
  const segmentCycles = Math.min(cycles, TEMPO_COMB_SEGMENT_CYCLES)
  const segmentFrames = Math.floor(segmentCycles * period)
  const sums = new Float64Array(bins)
  const counts = new Float64Array(bins)
  let coherent = 0
  let energy = 0
  for (let start = 0; start + segmentFrames <= frames; start += segmentFrames) {
    sums.fill(0)
    counts.fill(0)
    for (let offset = 0; offset < segmentFrames; offset += 1) {
      const value = envelope[start + offset]
      const phase = offset / period
      const bin = Math.min(bins - 1, Math.floor((phase - Math.floor(phase)) * bins))
      sums[bin] += value
      counts[bin] += 1
      energy += value * value
    }
    for (let bin = 0; bin < bins; bin += 1) {
      if (counts[bin] > 0) coherent += sums[bin] * sums[bin] / counts[bin]
    }
  }
  return energy > 1e-12 ? coherent / energy : 0
}

/**
 * Best prior-weighted tempo (as BPM) of a discrete curve inside the BPM band
 * [bandLo, bandHi], 0 when none. Both periodicity views are picked with this
 * same rule, so their comparison is like with like.
 */
function bestBpmInBand(
  curve: Float64Array,
  lo: number,
  hi: number,
  framesPerSecond: number,
  bandLo: number,
  bandHi: number
): number {
  let bestIndex = -1
  let bestValue = 0
  for (let lag = Math.max(2, lo); lag <= hi; lag += 1) {
    const bpm = (framesPerSecond * 60) / lag
    if (bpm < bandLo || bpm > bandHi) continue
    const value = curve[lag] * tempoPrior(bpm)
    if (value > bestValue) {
      bestValue = value
      bestIndex = lag
    }
  }
  if (bestIndex < 0 || !(bestValue > 0)) return 0
  const refined = parabolicLag(curve, bestIndex, Math.max(2, lo), hi)
  return (framesPerSecond * 60) / refined
}

/**
 * One periodicity view's own reading under the primary decision rule: its
 * prior-weighted best inside the decision band, then the same duple/triple
 * grouping rule (`resolveGrouping`) using that view's own periodicity, then the
 * same octave accent check (`octaveIsAccentless`) as the primary.
 */
function viewReading(
  curve: Float64Array,
  lo: number,
  hi: number,
  framesPerSecond: number,
  bandLo: number,
  bandHi: number,
  octaveIsAccentless: (bpm: number) => boolean
): number {
  const pick = bestBpmInBand(curve, lo, hi, framesPerSecond, bandLo, bandHi)
  if (!(pick > 0)) return 0
  const find = (target: number): number | null => {
    if (target < bandLo || target > bandHi) return null
    const centre = (framesPerSecond * 60) / target
    const from = Math.max(lo + 1, Math.floor(centre * (1 - TEMPO_AGREEMENT_TOLERANCE)))
    const to = Math.min(hi - 1, Math.ceil(centre * (1 + TEMPO_AGREEMENT_TOLERANCE)))
    let bestLag = -1
    for (let lag = from; lag <= to; lag += 1) {
      if (curve[lag] < curve[lag - 1] || curve[lag] < curve[lag + 1] || !(curve[lag] > 0)) continue
      if (bestLag < 0 || curve[lag] > curve[bestLag]) bestLag = lag
    }
    return bestLag < 0 ? null : (framesPerSecond * 60) / parabolicLag(curve, bestLag, lo, hi)
  }
  const grouped = resolveGrouping(pick, (bpm) => interpolateAt(curve, (framesPerSecond * 60) / bpm), find)
  const faster = find(grouped * 2)
  return faster != null && octaveIsAccentless(grouped) ? faster : grouped
}

/**
 * True when, in every given band envelope, the onsets are as periodic
 * (≥ `TEMPO_DUPLE_SUPPORT_RATIO`) at half of `period` as at `period` itself:
 * the reading at `period` has no beat/off-beat accent anywhere in the
 * spectrum.
 */
function accentlessOctave(bands: Float64Array[], period: number): boolean {
  let considered = 0
  for (const band of bands) {
    const slow = fractionalAutocorrelation(band, band.length, period)
    const fast = fractionalAutocorrelation(band, band.length, period / 2)
    if (!(slow > 0) || fast < slow * TEMPO_DUPLE_SUPPORT_RATIO) return false
    considered += 1
  }
  return considered > 0
}

/**
 * Duple/triple grouping rule for readings 3:2 apart.
 *
 * Such readings are a choice of grouping, not of tempo octave, so the
 * log-tempo prior must not decide between them: it sits nearer 120 BPM and
 * would group a 150 BPM kick-and-off-beat-hat loop in threes as 100 BPM, or a
 * 6/8 loop's eighths in twos as 90 BPM. The periodicity of each reading decides
 * instead. When the faster reading is as periodic as the slower one (at least
 * `TEMPO_DUPLE_SUPPORT_RATIO` of it), no accent groups that pulse in threes and
 * the duple (faster) reading stands; a genuinely triple pattern accents its
 * groups, which makes the slower reading clearly more periodic.
 *
 * `support` reads a view's periodicity at a tempo; `find` returns the related
 * in-band reading nearest a target tempo, or null when there is none.
 */
function resolveGrouping(
  pick: number,
  support: (bpm: number) => number,
  find: (target: number) => number | null
): number {
  const faster = find(pick * 1.5)
  if (faster != null && support(faster) >= support(pick) * TEMPO_DUPLE_SUPPORT_RATIO) return faster
  const slower = find(pick / 1.5)
  if (slower != null && support(pick) < support(slower) * TEMPO_DUPLE_SUPPORT_RATIO) return slower
  return pick
}

/**
 * Do the two periodicity methods name the same pulse?
 *
 * "Same" means within TEMPO_AGREEMENT_TOLERANCE (3 %) of the chosen tempo, and
 * — importantly — an exact octave between them counts as *disagreement about
 * which metrical level*, not agreement, because that is precisely the ambiguity
 * worth warning about.
 */
function tempoAgreement(
  chosen: number,
  autocorrelationBpm: number,
  combBpm: number
): { corroborated: boolean; note: string } {
  const terms: string[] = []
  let agreed = 0
  let considered = 0

  const check = (method: string, value: number): void => {
    if (!(value > 0)) return
    considered += 1
    const ratio = value / chosen
    if (Math.abs(ratio - 1) <= TEMPO_AGREEMENT_TOLERANCE) {
      agreed += 1
    } else if (Math.abs(ratio - 2) <= TEMPO_AGREEMENT_TOLERANCE || Math.abs(ratio - 0.5) <= TEMPO_AGREEMENT_TOLERANCE) {
      terms.push(`${method} read ${value.toFixed(1)} BPM, an octave away`)
    } else {
      terms.push(`${method} read ${value.toFixed(1)} BPM`)
    }
  }

  check('autocorrelation', autocorrelationBpm)
  check('comb filter', combBpm)

  if (considered === 0) {
    return { corroborated: false, note: 'Only one periodicity method produced a peak; the reading is uncorroborated.' }
  }
  if (agreed === considered) return { corroborated: true, note: '' }

  const detail = terms.length > 0 ? ` (${terms.join('; ')})` : ''
  return {
    corroborated: false,
    note: `Autocorrelation and comb-filter periodicity disagree on the beat${detail}.`
  }
}

/** Octave suppression: is `bpm` the same reading as anything already picked? */
function isSuppressed(bpm: number, used: number[]): boolean {
  for (const other of used) {
    const ratio = bpm / other
    if (Math.abs(ratio - 1) <= TEMPO_SUPPRESS_RATIO) return true
    if (Math.abs(ratio - 2) <= TEMPO_SUPPRESS_RATIO) return true
    if (Math.abs(ratio - 0.5) <= TEMPO_SUPPRESS_RATIO) return true
  }
  return false
}

/**
 * Builds the onset-strength envelope (log spectral flux), plus the same flux
 * split into `TEMPO_ACCENT_BAND_EDGES_HZ` bands. The bands are used only to
 * ask whether a slower octave reading has any accent (see `accentlessOctave`);
 * the period itself is measured on the full-band envelope.
 */
function spectralFluxEnvelope(
  pcm: Float32Array,
  fftSize: number,
  hop: number,
  frames: number,
  bins: number,
  level: number,
  sampleRate: number
): { envelope: Float64Array; bands: Float64Array[] } {
  const fft = new RealFft(fftSize)
  const window = hannWindow(fftSize)
  const magnitudes = new Float64Array(bins)
  let current = new Float64Array(bins)
  let previous = new Float64Array(bins)
  const envelope = new Float64Array(frames)
  const bandCount = TEMPO_ACCENT_BAND_EDGES_HZ.length + 1
  const bands = Array.from({ length: bandCount }, () => new Float64Array(frames))
  // Bands are contiguous bin ranges [bandStart[b], bandStart[b + 1]).
  const bandStart = new Int32Array(bandCount + 1)
  bandStart[bandCount] = bins
  for (let band = 1; band < bandCount; band += 1) {
    bandStart[band] = Math.min(bins, Math.ceil((TEMPO_ACCENT_BAND_EDGES_HZ[band - 1] * fftSize) / sampleRate))
  }

  // Log compression compresses the dynamic range of the flux, so a loud kick
  // does not drown out quiet hi-hat motion.
  // Relative to signal level: log(magnitude + 1e-6) previously amplified
  // stationary-tone FFT leakage into a strong artificial onset envelope.
  const LOG_FLOOR = Math.max(1e-9, level * fftSize * 0.01)

  for (let frame = 0; frame < frames; frame += 1) {
    fft.magnitudes(pcm, frame * hop, window, magnitudes, bins)

    const inverseFloor = 1 / LOG_FLOOR
    let flux = 0
    for (let band = 0; band < bandCount; band += 1) {
      let bandFlux = 0
      for (let bin = bandStart[band], end = bandStart[band + 1]; bin < end; bin += 1) {
        const logMagnitude = Math.log1p(magnitudes[bin] * inverseFloor)
        current[bin] = logMagnitude
        // Half-wave rectification: only rising energy is an onset.
        const diff = logMagnitude - previous[bin]
        if (diff > 0) bandFlux += diff
      }
      if (frame > 0) {
        bands[band][frame] = bandFlux
        flux += bandFlux
      }
    }
    envelope[frame] = flux
    const swap = previous
    previous = current
    current = swap
  }

  // First frame has no predecessor; mirror the second so it neither adds a
  // spurious onset nor biases the moving mean.
  if (frames > 1) {
    envelope[0] = envelope[1]
    for (const band of bands) band[0] = band[1]
  }

  // Band equalisation (see TEMPO_BAND_EQUALISATION). The mean onset energy is
  // preserved, so the stationary-spectrum floor keeps its meaning.
  const means = bands.map((band) => band.reduce((sum, value) => sum + value, 0) / Math.max(1, frames))
  const total = means.reduce((sum, value) => sum + value, 0)
  if (total > 0) {
    for (let i = 0; i < frames; i += 1) envelope[i] *= 1 - TEMPO_BAND_EQUALISATION
    for (let band = 0; band < bands.length; band += 1) {
      if (!(means[band] > total * TEMPO_BAND_EQUALISATION_MIN_SHARE)) continue
      const scale = TEMPO_BAND_EQUALISATION * (total / bands.length) / means[band]
      const values = bands[band]
      for (let i = 0; i < frames; i += 1) envelope[i] += values[i] * scale
    }
  }
  return { envelope, bands }
}

/**
 * Subtracts a centred moving mean of width `ONSET_TREND_SEC` and divides by the
 * mean absolute deviation, giving a scale-free, mean-zero onset envelope.
 */
function detrendEnvelope(envelope: Float64Array, framesPerSecond: number): Float64Array {
  const frames = envelope.length
  const out = new Float64Array(frames)
  const half = Math.max(1, Math.round((ONSET_TREND_SEC * framesPerSecond) / 2))

  // Prefix sums make the moving mean O(1) per frame and reproducible exactly.
  const prefix = new Float64Array(frames + 1)
  for (let i = 0; i < frames; i += 1) prefix[i + 1] = prefix[i] + envelope[i]

  for (let i = 0; i < frames; i += 1) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(frames, i + half + 1)
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo)
    const centred = envelope[i] - mean
    out[i] = centred > 0 ? centred : 0
  }

  let sum = 0
  for (let i = 0; i < frames; i += 1) sum += out[i]
  const scale = sum / frames
  if (scale > 1e-9) {
    for (let i = 0; i < frames; i += 1) out[i] /= scale
  }
  return out
}

/**
 * Pearson correlation between the envelope and itself at `lag`, computed over
 * the overlapping window only. Correlating each window against its own mean is
 * what makes a sparse click envelope behave: the long run of zeros between hits
 * contributes nothing rather than dragging the coefficient down.
 */
function normalisedAutocorrelation(x: Float64Array, n: number, lag: number): number {
  const count = n - lag
  if (count < 4) return 0

  let sumA = 0
  let sumB = 0
  for (let i = 0; i < count; i += 1) {
    sumA += x[i]
    sumB += x[i + lag]
  }
  const meanA = sumA / count
  const meanB = sumB / count

  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < count; i += 1) {
    const a = x[i] - meanA
    const b = x[i + lag] - meanB
    covariance += a * b
    varianceA += a * a
    varianceB += b * b
  }

  const denominator = Math.sqrt(varianceA * varianceB)
  if (!(denominator > 1e-12)) return 0
  const value = covariance / denominator
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0
}

/**
 * Gaussian prior on log-tempo (see `TEMPO_PRIOR_SIGMA_OCTAVES` for the source).
 * Multiplicative, so a tempo the signal does not support can never be created.
 */
function tempoPrior(bpm: number): number {
  if (!(bpm > 0)) return 0
  const octaves = Math.log2(bpm / TEMPO_PRIOR_CENTRE_BPM)
  const z = octaves / TEMPO_PRIOR_SIGMA_OCTAVES
  const value = Math.exp(-0.5 * z * z)
  return Number.isFinite(value) ? value : 0
}

/**
 * Parabolic interpolation of a discrete peak, carried out in log-lag space.
 * Tempo is proportional to 1/lag, so log-lag is the natural axis: a parabola
 * there is very close to a parabola in log-BPM, and the returned lag is the
 * sub-sample location of the true maximum.
 */
function parabolicLag(curve: Float64Array, index: number, lo: number, hi: number): number {
  if (index <= lo || index >= hi) return index
  const left = curve[index - 1]
  const centre = curve[index]
  const right = curve[index + 1]
  const denominator = left - 2 * centre + right
  if (!(Math.abs(denominator) > 1e-12)) return index
  const delta = clamp((0.5 * (left - right)) / denominator, -0.5, 0.5)
  const refined = index + delta
  if (!Number.isFinite(refined) || refined <= 0) return index
  return refined
}

/**
 * Refines a reported metrical level from fractional-lag autocorrelation at
 * whole multiples of its period (see `TEMPO_REFINE_MAX_MULTIPLES`). The search
 * stays within ±`TEMPO_REFINE_SPAN` of the picked period, so it sharpens the
 * period of the chosen level and cannot move to a different metrical level.
 * Every multiple must lie within half the envelope so each correlation still
 * averages many beat pairs.
 */
function refinePeriodFromMultiples(x: Float64Array, n: number, bpm: number, fps: number): number {
  if (!(bpm > 0)) return bpm
  const period = (fps * 60) / bpm
  const multiples = Math.min(TEMPO_REFINE_MAX_MULTIPLES, Math.floor(n / 2 / period))
  if (multiples < 1) return bpm
  const score = (candidate: number): number => {
    let total = 0
    for (let m = 1; m <= multiples; m += 1) total += fractionalAutocorrelation(x, n, m * candidate)
    return total
  }

  // Coarse grid over the span, then a finer grid around the best coarse point,
  // then a parabola through the best fine point and its neighbours. A coarse
  // best on the edge of the span means the picked period was off by more than
  // the span (the prior's slope can move a broad prior-weighted peak), so the
  // span is re-centred on it, at most twice.
  let best = period
  let bestScore = score(period)
  const coarseStep = period * TEMPO_REFINE_SPAN / 10
  for (let pass = 0, centre = period; pass < 3; pass += 1) {
    for (let k = -10; k <= 10; k += 1) {
      const candidate = centre + k * coarseStep
      if (candidate === best) continue
      const value = score(candidate)
      if (value > bestScore) { bestScore = value; best = candidate }
    }
    if (Math.abs(best - centre) < 9.5 * coarseStep) break
    centre = best
  }
  const fineStep = coarseStep / 5
  const centre = best
  const fine: number[] = []
  for (let k = -5; k <= 5; k += 1) {
    const value = k === 0 ? bestScore : score(centre + k * fineStep)
    fine.push(value)
    if (value > bestScore) { bestScore = value; best = centre + k * fineStep }
  }
  const index = Math.round((best - centre) / fineStep) + 5
  if (index > 0 && index < fine.length - 1) {
    const denominator = fine[index - 1] - 2 * fine[index] + fine[index + 1]
    if (Math.abs(denominator) > 1e-12) {
      best += clamp((0.5 * (fine[index - 1] - fine[index + 1])) / denominator, -0.5, 0.5) * fineStep
    }
  }
  const refined = (fps * 60) / best
  return Number.isFinite(refined) && refined > 0 ? refined : bpm
}

/**
 * Pearson correlation between the envelope and itself delayed by a fractional
 * `lag`, linearly interpolating the delayed copy. Same overlap convention as
 * `normalisedAutocorrelation`.
 */
function fractionalAutocorrelation(x: Float64Array, n: number, lag: number): number {
  const whole = Math.floor(lag)
  const t = lag - whole
  const count = n - whole - 1
  if (whole < 1 || count < 4) return 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < count; i += 1) {
    sumA += x[i]
    sumB += x[i + whole] * (1 - t) + x[i + whole + 1] * t
  }
  const meanA = sumA / count
  const meanB = sumB / count
  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < count; i += 1) {
    const a = x[i] - meanA
    const b = x[i + whole] * (1 - t) + x[i + whole + 1] * t - meanB
    covariance += a * b
    varianceA += a * a
    varianceB += b * b
  }
  const denominator = Math.sqrt(varianceA * varianceB)
  if (!(denominator > 1e-12)) return 0
  const value = covariance / denominator
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0
}

/** Gaussian smoothing with standard deviation `sigma` frames, edge-normalised. */
function gaussianSmooth(x: Float64Array, sigma: number): Float64Array {
  if (!(sigma > 0.25)) return x
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float64Array(2 * radius + 1)
  for (let k = -radius; k <= radius; k += 1) kernel[k + radius] = Math.exp(-0.5 * (k / sigma) ** 2)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i += 1) {
    let sum = 0
    let weight = 0
    const lo = Math.max(0, i - radius)
    const hi = Math.min(x.length - 1, i + radius)
    for (let j = lo; j <= hi; j += 1) {
      const w = kernel[j - i + radius]
      sum += x[j] * w
      weight += w
    }
    out[i] = weight > 0 ? sum / weight : 0
  }
  return out
}

/** Linear interpolation of a curve at a fractional index. */
function interpolateAt(curve: Float64Array, position: number): number {
  const lo = Math.floor(position)
  const hi = Math.min(curve.length - 1, lo + 1)
  if (lo < 0) return curve[0]
  const t = position - lo
  return curve[lo] * (1 - t) + curve[hi] * t
}

/** Strongest peak within ±`tolerance` BPM of `target`, skipping seen readings. */
function strongestPeakNear(
  peaks: TempoPeak[],
  target: number,
  tolerance: number,
  exclude: number[]
): TempoPeak | null {
  let best: TempoPeak | null = null
  for (const peak of peaks) {
    if (Math.abs(peak.bpm - target) > tolerance) continue
    // Octave candidates are intentionally being requested here. Suppressing
    // half/double relationships would reject every legitimate alternative.
    if (exclude.some((bpm) => Math.abs(peak.bpm / bpm - 1) <= TEMPO_SUPPRESS_RATIO)) continue
    if (!best || peak.strength > best.strength) best = peak
  }
  return best
}

/**
 * Confidence formula — a *normalised prominence*, NOT a probability:
 *
 *             peak      − background
 *   conf  =  ────────────────────────      clamped to 0..1
 *             peak      + background
 *
 * where `peak` is the prior-weighted combined periodicity at the winning peak
 * and `background` is the median of the un-prior-ed combined curve inside a
 * ±20 % band around the peak's lag (i.e. the local noise floor the peak has to
 * stand above, which is a fairer comparison than the curve's global mean because
 * periodicity magnitude drifts with lag). For a perfect impulse train the
 * background is ~0 and confidence approaches 1; for a flat, aperiodic envelope
 * peak ≈ background and confidence approaches 0.
 *
 * `background` is floored at a small positive value so the ratio stays finite.
 * The caller additionally scales this down when the autocorrelation and comb
 * filter disagree about the beat (see `TEMPO_DISAGREE_CONFIDENCE_SCALE`), so the
 * final reported confidence also encodes method agreement.
 */
function peakProminence(
  combined: Float64Array,
  lagMin: number,
  lagMax: number,
  framesPerBpm: number,
  peak: TempoPeak
): number {
  const lag = framesPerBpm / Math.max(1e-6, peak.bpm)
  const half = Math.max(2, Math.round(lag * 0.2))

  const lo = Math.max(lagMin, Math.round(lag) - half)
  const hi = Math.min(lagMax, Math.round(lag) + half)
  const window: number[] = []
  for (let i = lo; i <= hi; i += 1) {
    // Skip the peak's own neighbourhood so it is not its own background.
    if (Math.abs(i - lag) < 2) continue
    window.push(combined[i])
  }
  if (window.length === 0) return clamp01(peak.strength)
  window.sort((a, b) => a - b)
  const background = Math.max(1e-6, window[window.length >> 1])

  const value = peak.strength
  if (!(value > 0)) return 0
  return clamp01((value - background) / (value + background))
}

/** Builds an inconclusive tempo result with a human-readable reason. */
function inconclusiveTempo(warning: string): TempoAnalysis {
  const base = emptyTempoAnalysis()
  const status: FieldAnalysisStatus = 'inconclusive'
  return {
    ...base,
    status,
    bpm: null,
    bpmExact: null,
    alternatives: [],
    confidence: null,
    warning
  }
}

/* ------------------------------------------------------------------------- */
/* estimateKey                                                                */
/* ------------------------------------------------------------------------- */

/** One candidate key and its Krumhansl–Schmuckler correlation. */
interface KeyCandidate {
  key: string
  camelot: string | null
  correlation: number
  pitchClass: number
  mode: 'major' | 'minor'
}

/**
 * Estimates musical key from the audio signal.
 *
 * Pipeline: Hann-windowed STFT → narrow spectral peaks with log-magnitude
 * interpolation → equally weighted frame pitch histograms → global tuning
 * alignment → 12-bin chroma → Pearson correlation against 24 Shaath profiles.
 * Complete-triad observations can corroborate a close relative-key result;
 * weak, flat, single-pitch and unresolved relative-key evidence still abstains.
 */
export function estimateKey(input: AnalysisInput): KeyAnalysis {
  try {
    const sanitized = sanitizeInput(input)
    return noteReplacedSamples(estimateKeyInner(sanitized.input), sanitized.replaced)
  } catch {
    const failed = emptyKeyAnalysis()
    return { ...failed, status: 'failed', warning: 'Key analysis failed unexpectedly.' }
  }
}

function estimateKeyInner(input: AnalysisInput): KeyAnalysis {
  const pcm = input.pcm
  const sampleRate = Math.floor(finiteOr(input.sampleRate, 0))
  const samples = pcm && typeof pcm.length === 'number' ? pcm.length : 0

  if (samples === 0) {
    return inconclusiveKey('No audio samples were available to analyse.')
  }
  if (sampleRate <= 0) {
    return inconclusiveKey('The sample rate was invalid, so the key could not be estimated.')
  }

  const seconds = samples / sampleRate
  const level = rms(pcm, 0, samples)
  if (!(level > 1e-6)) {
    return inconclusiveKey('The audio is silent, so no key could be estimated.')
  }

  const fftSize = fftSizeFor(
    Math.max(2, Math.round(KEY_WINDOW_SEC * sampleRate)),
    KEY_MIN_FFT,
    KEY_MAX_FFT
  )
  const hop = Math.max(1, Math.round(fftSize * KEY_HOP_RATIO))
  const bins = fftSize >> 1
  const availableFrames = samples >= fftSize ? 1 + Math.floor((samples - fftSize) / hop) : 0
  const maxFrames = Math.floor((KEY_MAX_SECONDS * sampleRate) / hop)
  const frames = Math.min(availableFrames, maxFrames)

  if (seconds < KEY_MIN_AUDIO_SEC || frames < KEY_MIN_FRAMES) {
    return inconclusiveKey(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${KEY_MIN_AUDIO_SEC} s is needed to establish a key.`
    )
  }

  const binHz = sampleRate / fftSize

  // ---- fine pitch histogram ----------------------------------------------
  const fine = new Float64Array(TUNING_FINE_BINS)
  const frameFine = new Float64Array(TUNING_FINE_BINS)
  const chordVotes = new Float64Array(24)
  const fft = new RealFft(fftSize)
  const window = hannWindow(fftSize)
  const magnitudes = new Float64Array(bins)

  // Chroma runs over the register where fundamentals and the first strong
  // partials live. Above ~3 kHz the spectrum is dense with high harmonics that
  // carry little tonal information and would dilute the profile.
  const minPeakBin = Math.max(1, Math.ceil(CHROMA_MIN_HZ / binHz))
  const maxPeakBin = Math.min(bins - 2, Math.floor(CHROMA_MAX_HZ / binHz))

  let accumulated = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * hop
    const frameLevel = rms(pcm, offset, offset + fftSize)
    // Near-silent frames contribute only numerical dust; skipping them keeps
    // the chroma from turning into an average of the noise floor.
    if (!(frameLevel > level * 0.15)) continue

    const magnitudeLimit = Math.min(bins - 1, maxPeakBin + KEY_PEAK_NEIGHBOUR_RADIUS)
    fft.magnitudes(pcm, offset, window, magnitudes, magnitudeLimit + 1)

    frameFine.fill(0)
    accumulateChroma(magnitudes, binHz, minPeakBin, maxPeakBin, frameFine)
    let frameTotal = 0
    for (const value of frameFine) frameTotal += value
    if (!(frameTotal > 1e-9)) continue
    accumulateChordVotes(frameFine, chordVotes)
    // Give each usable observation equal mass. Summing raw spectral energy
    // allowed lower-register / louder chords to dominate the entire excerpt.
    for (let bin = 0; bin < fine.length; bin += 1) fine[bin] += frameFine[bin] / frameTotal
    accumulated += 1
  }

  let fineTotal = 0
  for (let i = 0; i < TUNING_FINE_BINS; i += 1) fineTotal += fine[i]

  if (accumulated < KEY_MIN_FRAMES || !(fineTotal > 1e-9)) {
    return inconclusiveKey('Too little pitched material was present to establish a key.')
  }

  // ---- global tuning ------------------------------------------------------
  const tuningCents = estimateTuningCents(fine)

  // ---- chroma -------------------------------------------------------------
  const chroma = foldToChroma(fine, tuningCents)

  // ---- chroma energy / variance guard ------------------------------------
  // A Pearson correlation against an all-zero (or numerically dead) chroma is 0
  // *by construction*, which is indistinguishable from "no key found" if the
  // correlation alone is trusted. So the chroma is validated as a distribution
  // before any correlation is believed: it must carry real total energy and a
  // real spread across pitch classes. Frames are gated and the histogram is
  // accumulated from real spectral peaks, so reaching here with a dead chroma
  // means the material genuinely had no pitched content (all-percussion, DC
  // offset, pure noise beneath the gate).
  let chromaEnergy = 0
  for (let i = 0; i < 12; i += 1) chromaEnergy += chroma[i]
  const chromaVariance = chromaVarianceOf(chroma)
  if (!(chromaEnergy > KEY_MIN_CHROMA_ENERGY) || !(chromaVariance > KEY_MIN_CHROMA_VARIANCE)) {
    return {
      ...inconclusiveKey(
        `The chroma profile carried no usable pitch content (energy ${chromaEnergy.toFixed(3)}, variance ${chromaVariance.toExponential(1)}).`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  // ---- Krumhansl–Schmuckler ----------------------------------------------
  // ---- scale residual gate (see KEY_MIN_SCALE_RESIDUAL) -------------------
  if (scaleResidual(chroma) < KEY_MIN_SCALE_RESIDUAL) {
    return {
      ...inconclusiveKey('Apart from its strongest pitch, the pitch content did not follow a scale; the material may be percussive or noisy.'),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  // ---- Krumhansl–Schmuckler with key-signature eligibility ---------------
  const candidates = rankByScaleFit(correlateKeyProfiles(chroma), chroma)
  const winner = candidates[0]

  const entropy = chromaEntropy(chroma)
  const absolute = Math.abs(winner.correlation)
  if (absolute < KEY_MIN_CORRELATION) {
    return {
      ...inconclusiveKey(
        `The chroma profile was too weakly tonal (best correlation ${absolute.toFixed(2)}); the material may be percussive or unpitched.`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }
  if (entropy > KEY_MAX_ENTROPY) {
    return {
      ...inconclusiveKey(
        `The chroma profile was nearly flat (entropy ${entropy.toFixed(2)}); no single tonal centre dominated.`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }
  if (entropy < KEY_MIN_ENTROPY) {
    return {
      ...inconclusiveKey(
        `The audio was dominated by a single pitch (entropy ${entropy.toFixed(2)}), which is not enough to establish a key.`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  // ---- alternatives -------------------------------------------------------
  // Relative major/minor is the dominant real-world confusion: the two scales
  // share 7 of 12 pitch classes, so the runner-up for a tonal excerpt is
  // usually its relative key. It is surfaced explicitly and guaranteed a slot
  // rather than being left to chance in the ranking, because it is the single
  // most useful thing to show next to the winner.
  const alternatives = selectKeyAlternatives(candidates, winner)
  const relative = candidates.find((candidate) => candidate.key === relativeKeyOf(winner.key))
  const sustainedTonic = relative != null && hasSustainedTonicEvidence(chordVotes, winner, relative, accumulated)
  if (relative && winner.correlation - relative.correlation < 0.12 && !sustainedTonic) {
    // A histogram cannot distinguish relative modes reliably when their
    // evidence is this close. Preserve the ranked evidence for review, rather
    // than converting a small scoring margin into a definitive major key.
    return {
      ...inconclusiveKey(`Relative-key ambiguity: ${winner.key} and ${relative.key} have similar acoustic support.`),
      alternatives: [winner, ...alternatives].slice(0, KEY_MAX_ALTERNATIVES).map(({ key, camelot, correlation }) => ({ key, camelot, correlation })),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  return {
    status: 'estimated',
    key: winner.key,
    camelot: winner.camelot,
    correlation: winner.correlation,
    alternatives,
    confidence: keyConfidence(candidates),
    tuningCents: roundToStep(tuningCents, 0.1),
    warning: sustainedTonic && relative && winner.correlation - relative.correlation < 0.12
      ? 'The pitch profile also fits the relative key; sustained tonic-chord evidence supports this estimate.'
      : null
  }
}

/**
 * A pitch histogram loses chord ordering and can confuse an inverted minor
 * tonic with its relative major. Count only clear, complete major/minor triads;
 * no bass-note, first-chord or filename prior is used. Peaks are rounded only
 * for this corroborating view; the primary chroma keeps full tuning correction.
 */
function accumulateChordVotes(fine: Float64Array, votes: Float64Array): void {
  const chroma = new Float64Array(12)
  let total = 0
  for (let bin = 0; bin < fine.length; bin += 1) {
    chroma[Math.round(bin / TUNING_BINS_PER_SEMITONE) % 12] += fine[bin]
    total += fine[bin]
  }
  if (!(total > 0)) return
  let best = 0
  let second = 0
  let bestIndex = -1
  for (let mode = 0; mode < 2; mode += 1) {
    for (let root = 0; root < 12; root += 1) {
      const third = chroma[(root + (mode === 0 ? 4 : 3)) % 12] / total
      const tonic = chroma[root] / total
      const fifth = chroma[(root + 7) % 12] / total
      if (Math.min(tonic, third, fifth) < 0.08) continue
      // Square roots limit doubled-note loudness without adding missing tones.
      const similarity = (Math.sqrt(tonic) + Math.sqrt(third) + Math.sqrt(fifth)) / Math.sqrt(3)
      if (similarity > best) {
        second = best
        best = similarity
        bestIndex = mode * 12 + root
      } else if (similarity > second) second = similarity
    }
  }
  if (bestIndex >= 0 && best >= 0.85 && best - second >= 0.08) votes[bestIndex] += 1
}

function hasSustainedTonicEvidence(votes: Float64Array, winner: KeyCandidate, relative: KeyCandidate, frames: number): boolean {
  const index = winner.pitchClass + (winner.mode === 'minor' ? 12 : 0)
  const relativeIndex = relative.pitchClass + (relative.mode === 'minor' ? 12 : 0)
  let otherChord = 0
  for (let i = 0; i < votes.length; i += 1) if (i !== index) otherChord = Math.max(otherChord, votes[i])
  // At least 40% of all pitched frames must support this complete tonic, with
  // a different chord observed for at least 10%. A drone or a single held chord
  // cannot resolve mode, and evenly balanced relative-key loops still abstain.
  return votes[index] >= frames * 0.4 && votes[index] - votes[relativeIndex] >= frames * 0.2 && otherChord >= frames * 0.1
}

/**
 * Chooses the reported alternatives: the best few rotations by correlation, with
 * the relative major/minor of the winner guaranteed a place when it is close
 * enough to be a plausible reading.
 *
 * Ranking is by correlation (best-first) and the winner is never duplicated.
 */
function selectKeyAlternatives(candidates: KeyCandidate[], winner: KeyCandidate): KeyAlternative[] {
  const relativeKeyName = relativeKeyOf(winner.key)
  const isRelative = (candidate: KeyCandidate): boolean => candidate.key === relativeKeyName

  const ranked = candidates.filter((candidate) => candidate.key !== winner.key)
  const selected = ranked.slice(0, KEY_MAX_ALTERNATIVES)

  // Guarantee the relative key a slot when it is within
  // KEY_RELATIVE_SURFACE_MARGIN of the top correlation — i.e. genuinely
  // competitive, not merely present.
  const relative = ranked.find(isRelative)
  if (
    relative &&
    !selected.some(isRelative) &&
    Math.abs(relative.correlation) >= Math.abs(winner.correlation) - KEY_RELATIVE_SURFACE_MARGIN
  ) {
    selected.pop()
    selected.push(relative)
  }

  // Re-sort so the array is always strongest-first, whatever path built it.
  selected.sort((a, b) => b.correlation - a.correlation || a.pitchClass - b.pitchClass)

  return selected.map((candidate) => ({
    key: candidate.key,
    camelot: candidate.camelot,
    correlation: finiteOr(candidate.correlation, 0)
  }))
}

/** Chroma mass on the scale `steps` above `root`, skipping `skip` (or -1). */
function scaleMass(chroma: Float64Array, root: number, steps: readonly number[], skip = -1): number {
  let mass = 0
  for (const step of steps) {
    const pitchClass = (root + step) % 12
    if (pitchClass !== skip) mass += chroma[pitchClass]
  }
  return mass
}

/**
 * Best 7-note (major-scale collection) fit of the chroma once its strongest
 * pitch class is removed, as a share of the remaining mass. See
 * `KEY_MIN_SCALE_RESIDUAL`.
 */
function scaleResidual(chroma: Float64Array): number {
  let top = 0
  let topIndex = 0
  for (let i = 0; i < 12; i += 1) if (chroma[i] > top) { top = chroma[i]; topIndex = i }
  const remaining = 1 - top
  if (!(remaining > 1e-9)) return 0
  let best = 0
  for (let root = 0; root < 12; root += 1) best = Math.max(best, scaleMass(chroma, root, MAJOR_SCALE, topIndex) / remaining)
  return best
}

/**
 * Moves keys whose scale fits the chroma clearly worse than the best-fitting
 * scale (see `KEY_SCALE_FIT_MARGIN`) behind the eligible ones, keeping each
 * group in correlation order. Nothing is removed, so alternatives still show
 * the excluded readings.
 */
function rankByScaleFit(candidates: KeyCandidate[], chroma: Float64Array): KeyCandidate[] {
  const fitOf = (candidate: KeyCandidate): number => candidate.mode === 'major'
    ? scaleMass(chroma, candidate.pitchClass, MAJOR_SCALE)
    : Math.max(scaleMass(chroma, candidate.pitchClass, NATURAL_MINOR_SCALE), scaleMass(chroma, candidate.pitchClass, HARMONIC_MINOR_SCALE))
  const fits = candidates.map(fitOf)
  const threshold = Math.max(...fits) - KEY_SCALE_FIT_MARGIN
  return [
    ...candidates.filter((_, index) => fits[index] >= threshold),
    ...candidates.filter((_, index) => fits[index] < threshold)
  ]
}

/** `C major` → `A minor` and vice versa; null when the string is not canonical. */
function relativeKeyOf(key: string): string | null {
  const match = /^([A-G]#?) (major|minor)$/.exec(key)
  if (!match) return null
  const index = SHARP_NAMES.indexOf(match[1] as (typeof SHARP_NAMES)[number])
  if (index < 0) return null
  return match[2] === 'major'
    ? `${SHARP_NAMES[(index + 9) % 12]} minor`
    : `${SHARP_NAMES[(index + 3) % 12]} major`
}

/** Population variance of the 12 chroma bins. */
function chromaVarianceOf(chroma: Float64Array): number {
  let mean = 0
  for (let i = 0; i < 12; i += 1) mean += chroma[i]
  mean /= 12
  let variance = 0
  for (let i = 0; i < 12; i += 1) {
    const d = chroma[i] - mean
    variance += d * d
  }
  variance /= 12
  return Number.isFinite(variance) ? variance : 0
}

/**
 * Extract narrow local maxima, reject the noise floor and broad percussive
 * humps, then refine each peak using a parabola in log magnitude. This follows
 * the spectral-peak interpolation described at
 * https://essentia.upf.edu/reference/std_SpectralPeaks.html.
 *
 * Each resolved partial votes once for its own pitch class. Amplitude weighting
 * reduces loud-note dominance compared with power; the old 1/f bin-density
 * compensation is inappropriate for peaks and exaggerated bass/inversion bias.
 * No unobserved subharmonic votes or learned model are introduced.
 */
function accumulateChroma(
  magnitudes: Float64Array,
  binHz: number,
  minPeakBin: number,
  maxPeakBin: number,
  fine: Float64Array
): void {
  if (maxPeakBin <= minPeakBin) return
  let strongest = 0
  for (let bin = minPeakBin; bin <= maxPeakBin; bin += 1) strongest = Math.max(strongest, magnitudes[bin])

  for (let bin = minPeakBin; bin <= maxPeakBin; bin += 1) {
    const magnitude = magnitudes[bin]
    if (!(magnitude > strongest * KEY_PEAK_RELATIVE_FLOOR)) continue
    if (!(magnitude > magnitudes[bin - 1] && magnitude >= magnitudes[bin + 1])) continue
    let surrounding = 0
    let neighbours = 0
    for (let distance = 3; distance <= KEY_PEAK_NEIGHBOUR_RADIUS; distance += 1) {
      if (bin - distance >= 0) { surrounding += magnitudes[bin - distance]; neighbours += 1 }
      if (bin + distance < magnitudes.length) { surrounding += magnitudes[bin + distance]; neighbours += 1 }
    }
    if (!(magnitude > KEY_PEAK_MIN_CONTRAST * surrounding / Math.max(1, neighbours))) continue

    // Parabolic interpolation in log magnitude locates the actual partial,
    // rather than spreading the Hann main lobe across neighbouring notes.
    const left = Math.log(Math.max(magnitudes[bin - 1], 1e-12))
    const centre = Math.log(Math.max(magnitude, 1e-12))
    const right = Math.log(Math.max(magnitudes[bin + 1], 1e-12))
    const curvature = left - 2 * centre + right
    const offset = Math.abs(curvature) > 1e-12 ? clamp(0.5 * (left - right) / curvature, -0.5, 0.5) : 0
    const frequency = (bin + offset) * binHz
    if (frequency < CHROMA_MIN_HZ || frequency > CHROMA_MAX_HZ) continue

    addToFineHistogram(fine, frequency, magnitude)
  }
}

/**
 * Adds `weight` at the pitch of `frequency` into the fine histogram.
 *
 * `frequency` is mapped to the fractional semitone relative to A440 and then
 * modulo 12, i.e. a pitch class in semitones with 100 bins per semitone
 * (1 cent). Linear interpolation between the two neighbouring bins keeps a
 * 1-cent tuning shift visible in the histogram, which is what makes the tuning
 * estimate below possible at all.
 */
function addToFineHistogram(fine: Float64Array, frequency: number, weight: number): void {
  if (!(frequency > 0) || !(weight > 0)) return
  const semitonesFromA = 12 * Math.log2(frequency / 440)
  if (!Number.isFinite(semitonesFromA)) return

  // Rotate so that index 0 is **C**, not A.
  //
  // `log2(f/440)` makes A the reference, but `SHARP_NAMES` and the
  // key profiles are both C-referenced. Leaving the histogram
  // A-referenced shifts every pitch class by three semitones, which does not
  // look like a bug from the outside — it returns confident, plausible-looking
  // keys that are simply wrong (C major came back as D# major, F# minor as A
  // minor, Eb major as F# major). C is nine semitones above A.
  const semitonesFromC = semitonesFromA + 9
  const pitchClass = ((semitonesFromC % 12) + 12) % 12
  const position = pitchClass * TUNING_BINS_PER_SEMITONE

  const lo = Math.floor(position)
  const t = position - lo
  const a = ((lo % TUNING_FINE_BINS) + TUNING_FINE_BINS) % TUNING_FINE_BINS
  const b = (a + 1) % TUNING_FINE_BINS
  fine[a] += weight * (1 - t)
  fine[b] += weight * t
}

/**
 * Estimates the global tuning offset by maximising chroma peak alignment.
 *
 * For every candidate offset in ±`TUNING_SEARCH_CENTS` we rotate the fine
 * histogram and fold it into 12 semitone bins, then measure how concentrated
 * the result is with the sum of squared bin shares. A correctly tuned histogram
 * stacks all its mass on the semitone grid and scores high; a histogram detuned
 * by δ cents splits its mass between adjacent bins and scores low. The best
 * offset is refined by a parabolic fit over the three neighbouring candidates.
 *
 * This is an analysis-only correction: it aligns bins before the final chroma.
 */
function estimateTuningCents(fine: Float64Array): number {
  let bestCents = 0
  let bestScore = -Infinity
  const scores: number[] = []
  const offsets: number[] = []

  for (
    let cents = -TUNING_SEARCH_CENTS;
    cents <= TUNING_SEARCH_CENTS;
    cents += TUNING_STEP_CENTS
  ) {
    const score = foldedConcentration(fine, cents)
    scores.push(score)
    offsets.push(cents)
    if (score > bestScore) {
      bestScore = score
      bestCents = cents
    }
  }

  const index = offsets.indexOf(bestCents)

  // A genuine tuning offset produces an **interior** peak in the concentration
  // curve. If the maximum sits on the edge of the search range, the objective is
  // monotonic rather than peaked, which means it has not actually located a
  // tuning — it has simply run out of range. Reporting that boundary value would
  // rotate the chroma by up to half a semitone and smear every pitch class, so
  // "no reliable offset" returns 0 (no correction).
  if (index <= 0 || index >= scores.length - 1) return 0

  // The peak must also stand clear of the curve's own middle, or it is noise.
  const sorted = [...scores].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!(bestScore > median * 1.001)) return 0

  if (index > 0 && index < scores.length - 1) {
    const left = scores[index - 1]
    const centre = scores[index]
    const right = scores[index + 1]
    const denominator = left - 2 * centre + right
    if (Math.abs(denominator) > 1e-12) {
      const delta = clamp((0.5 * (left - right)) / denominator, -0.5, 0.5)
      bestCents += delta * TUNING_STEP_CENTS
    }
  }

  return clamp(finiteOr(bestCents, 0), -TUNING_SEARCH_CENTS, TUNING_SEARCH_CENTS)
}

/**
 * Folds the fine pitch-class histogram into 12 chroma bins, rotated by
 * `shiftBins` fine bins (used for the tuning correction).
 *
 * The fine histogram has `TUNING_BINS_PER_SEMITONE` (100) bins per semitone, so
 * the pitch class of fine bin `i` is
 * `floor(i / TUNING_BINS_PER_SEMITONE) mod 12`.
 *
 * Deriving it as `i mod 12` instead — which is easy to write by mistake, because
 * both numbers are 12-ish — cycles through all twelve pitch classes *within a
 * single semitone*. That scrambles the distribution into something nearly
 * uniform: key detection collapses to a flat chroma, and the tuning objective
 * (peak concentration) becomes meaningless, so the search wanders to the edge of
 * its range. Both callers therefore share this one implementation, so the two
 * folds cannot drift apart.
 */
function foldFineToChroma(fine: Float64Array, shiftBins: number, out: Float64Array): void {
  const total = TUNING_FINE_BINS

  for (let i = 0; i < total; i += 1) {
    const value = fine[i]
    if (!(value > 0)) continue

    // Shift and index are both fine-bin units. Dividing the shift by 100 here
    // before dividing the difference would apply only 1/100 of the correction.
    let semitone = (i - shiftBins) / TUNING_BINS_PER_SEMITONE
    semitone = ((semitone % 12) + 12) % 12

    const lo = Math.floor(semitone)
    const t = semitone - lo
    const a = lo % 12
    const b = (a + 1) % 12

    out[a] += value * (1 - t)
    out[b] += value * t
  }
}

/** Sum of squared bin shares after folding the histogram at `cents`. */
function foldedConcentration(fine: Float64Array, cents: number): number {
  const folded = new Float64Array(12)
  foldFineToChroma(fine, (cents * TUNING_BINS_PER_SEMITONE) / 100, folded)

  let sum = 0
  let sumSquares = 0
  for (let i = 0; i < 12; i += 1) {
    sum += folded[i]
    sumSquares += folded[i] * folded[i]
  }
  if (!(sum > 0)) return 0
  return sumSquares / (sum * sum)
}

/** Folds the tuned fine histogram into a 12-bin, L1-normalised chroma. */
function foldToChroma(fine: Float64Array, tuningCents: number): Float64Array {
  const chroma = new Float64Array(12)
  foldFineToChroma(fine, (tuningCents * TUNING_BINS_PER_SEMITONE) / 100, chroma)

  let sum = 0
  for (let i = 0; i < 12; i += 1) sum += chroma[i]
  if (sum > 0) {
    for (let i = 0; i < 12; i += 1) chroma[i] /= sum
  }
  return chroma
}

/**
 * Normalised Shannon entropy of the chroma, in 0..1 (divided by ln 12).
 * ~1 means perfectly flat (no tonal centre); a clean triad lands well below.
 */
function chromaEntropy(chroma: Float64Array): number {
  let entropy = 0
  for (let i = 0; i < 12; i += 1) {
    const p = chroma[i]
    if (p > 1e-12) entropy -= p * Math.log(p)
  }
  const normalised = entropy / Math.log(12)
  return clamp01(finiteOr(normalised, 1))
}

/**
 * Pearson-correlates the chroma against all 24 rotations of the
 * Shaath major and minor profiles and returns them best-first.
 */
function correlateKeyProfiles(chroma: Float64Array): KeyCandidate[] {
  const candidates: KeyCandidate[] = []
  const profiles: { mode: 'major' | 'minor'; profile: readonly number[] }[] = [
    { mode: 'major', profile: KEY_MAJOR_PROFILE },
    { mode: 'minor', profile: KEY_MINOR_PROFILE }
  ]

  for (const { mode, profile } of profiles) {
    // A profile vector and the chroma both hold 12 equal-length vectors; the
    // profile statistics are rotation-invariant, so they are computed once.
    let profileMean = 0
    for (let i = 0; i < 12; i += 1) profileMean += profile[i]
    profileMean /= 12
    let profileVariance = 0
    for (let i = 0; i < 12; i += 1) {
      const d = profile[i] - profileMean
      profileVariance += d * d
    }
    const profileStd = Math.sqrt(profileVariance)

    let chromaMean = 0
    for (let i = 0; i < 12; i += 1) chromaMean += chroma[i]
    chromaMean /= 12
    let chromaVariance = 0
    for (let i = 0; i < 12; i += 1) {
      const d = chroma[i] - chromaMean
      chromaVariance += d * d
    }
    const chromaStd = Math.sqrt(chromaVariance)

    for (let tonic = 0; tonic < 12; tonic += 1) {
      let correlation = 0
      if (profileStd > 1e-12 && chromaStd > 1e-12) {
        let covariance = 0
        for (let i = 0; i < 12; i += 1) {
          covariance += (chroma[(i + tonic) % 12] - chromaMean) * (profile[i] - profileMean)
        }
        correlation = covariance / (chromaStd * profileStd)
      }
      const key = `${SHARP_NAMES[tonic]} ${mode}`
      candidates.push({
        key,
        camelot: camelotFor(SHARP_NAMES[tonic], mode),
        correlation: clamp(finiteOr(correlation, 0), -1, 1),
        pitchClass: tonic,
        mode
      })
    }
  }

  // Deterministic tie-break: correlation first, then the fixed SHARP_NAMES
  // order, then major before minor.
  candidates.sort(
    (a, b) =>
      b.correlation - a.correlation ||
      a.pitchClass - b.pitchClass ||
      (a.mode === b.mode ? 0 : a.mode === 'major' ? -1 : 1)
  )
  return candidates
}

/**
 * Confidence formula — the geometric mean of two normalised terms, NOT a
 * probability:
 *
 *   margin     = clamp01((best − runnerUp) / 0.25)
 *   absolute   = clamp01(|best| / 0.9)
 *   confidence = sqrt(margin × absolute)          clamped to 0..1
 *
 * `margin` says the winner beat the field; `absolute` says the winner is a
 * genuinely good fit rather than the least-bad of 24 bad fits. Requiring both
 * (geometric mean) is what stops an ambiguous piece from scoring high just
 * because one rotation happened to win by a hair, and stops a strong-but-flat
 * result from scoring high on margin alone. The divisors 0.25 and 0.9 are the
 * scale of a clearly-decided and a clearly-tonal result respectively.
 *
 * Relative-major/minor confusion is the dominant real-world error mode, and it
 * shows up here naturally: when a piece is genuinely ambiguous between a key
 * and its relative, the two correlations are close, `margin` collapses, and
 * confidence falls with it — which is the correct outcome. The relative key is
 * also forced into `alternatives` (see `selectKeyAlternatives`) so the ambiguity
 * is visible to the user rather than hidden behind one number.
 */
function keyConfidence(candidates: KeyCandidate[]): number {
  if (candidates.length < 2) return 0
  const best = Math.abs(candidates[0].correlation)
  const runnerUp = Math.abs(candidates[1].correlation)
  const margin = clamp01((best - runnerUp) / 0.25)
  const absolute = clamp01(best / 0.9)
  return clamp01(Math.sqrt(margin * absolute))
}

/** Builds an inconclusive key result with a human-readable reason. */
function inconclusiveKey(warning: string): KeyAnalysis {
  const base = emptyKeyAnalysis()
  const status: FieldAnalysisStatus = 'inconclusive'
  return {
    ...base,
    status,
    key: null,
    camelot: null,
    alternatives: [],
    confidence: null,
    tuningCents: null,
    warning
  }
}
