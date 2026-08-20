use std::path::Path;

use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    error::{AppError, AppResult},
    metadata::{MetadataMatch, MusicMetadata},
    models::FinalMetadata,
    tools::{configure_std_command, limited_text, media_tool_path},
};

pub const ANALYZER_VERSION: &str = "sonic-tempo-1";
pub const AUTO_ACCEPT_CONFIDENCE: f64 = 0.70;
pub const KEY_AUTO_ACCEPT_CONFIDENCE: f64 = 0.72;
const MIN_ANALYSIS_SECONDS: usize = 8;
const MAX_ANALYSIS_SECONDS: usize = 180;
const ONSET_FRAMES_PER_SECOND: usize = 200;
const DECODE_SAMPLE_RATE: u32 = 4_000;
const MAX_PCM_BYTES: usize = MAX_ANALYSIS_SECONDS * DECODE_SAMPLE_RATE as usize * 4;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TempoEstimate {
    pub primary: f64,
    pub alternates: Vec<f64>,
    pub confidence: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysis {
    pub source_sha256: String,
    pub analyzer_version: String,
    pub analyzed_duration_ms: u64,
    pub bpm: Option<TempoEstimate>,
    pub key: Option<KeyEstimate>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEstimate {
    pub primary: String,
    pub camelot: String,
    pub confidence: f64,
}

pub fn analyze_audio(
    app: &AppHandle,
    path: &Path,
    source_sha256: String,
) -> AppResult<AudioAnalysis> {
    let executable = media_tool_path(app, "ffmpeg")?;
    let mut command = std::process::Command::new(&executable);
    command.args(["-nostdin", "-hide_banner", "-v", "error", "-i"]);
    command.arg(path);
    command.args([
        "-t",
        &MAX_ANALYSIS_SECONDS.to_string(),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        &DECODE_SAMPLE_RATE.to_string(),
        "-f",
        "f32le",
        "pipe:1",
    ]);
    configure_std_command(&mut command, executable.parent());
    let output = command
        .output()
        .map_err(|error| AppError::Engine(format!("Could not start tempo analysis: {error}")))?;
    if !output.status.success() {
        let message = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(AppError::Process(if message.is_empty() {
            "FFmpeg could not decode audio for tempo analysis".into()
        } else {
            format!("FFmpeg could not decode audio for tempo analysis: {message}")
        }));
    }
    if output.stdout.len() > MAX_PCM_BYTES || output.stdout.len() % 4 != 0 {
        return Err(AppError::Process(
            "FFmpeg returned malformed or oversized tempo-analysis audio".into(),
        ));
    }
    let samples = output
        .stdout
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect::<Vec<_>>();
    let analyzed_duration_ms =
        (samples.len() as u64).saturating_mul(1_000) / u64::from(DECODE_SAMPLE_RATE);
    let bpm = analyze_tempo_samples(&samples, DECODE_SAMPLE_RATE);
    let key = analyze_key_samples(&samples, DECODE_SAMPLE_RATE);
    let warnings = if bpm.is_some() && key.is_some() {
        Vec::new()
    } else {
        [
            bpm.is_none()
                .then_some("Tempo could not be detected reliably from this audio"),
            key.is_none()
                .then_some("Musical key could not be detected reliably from this audio"),
        ]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .collect()
    };
    Ok(AudioAnalysis {
        source_sha256,
        analyzer_version: ANALYZER_VERSION.into(),
        analyzed_duration_ms,
        bpm,
        key,
        warnings,
    })
}

pub fn apply_to_music_metadata(metadata: &mut MusicMetadata, analysis: &AudioAnalysis) -> bool {
    let mut applied = apply_key_to_music_metadata(metadata, analysis);
    if metadata.bpm.is_some() {
        return applied;
    }
    let Some(tempo) = analysis
        .bpm
        .as_ref()
        .filter(|tempo| tempo.confidence >= AUTO_ACCEPT_CONFIDENCE)
    else {
        return applied;
    };
    metadata.bpm = Some(tempo.primary);
    metadata.alternate_bpms = tempo.alternates.clone();
    metadata.confidence = metadata.confidence.max(tempo.confidence);
    metadata.matches.push(analysis_match(tempo));
    applied = true;
    applied
}

pub fn apply_to_final_metadata(metadata: &mut FinalMetadata, analysis: &AudioAnalysis) -> bool {
    let mut applied = apply_key_to_final_metadata(metadata, analysis);
    if metadata.bpm.is_some() {
        return applied;
    }
    let Some(tempo) = analysis
        .bpm
        .as_ref()
        .filter(|tempo| tempo.confidence >= AUTO_ACCEPT_CONFIDENCE)
    else {
        return applied;
    };
    metadata.bpm = Some(tempo.primary);
    metadata.alternate_bpms = tempo.alternates.clone();
    metadata.evidence.push(analysis_match(tempo));
    applied = true;
    applied
}

pub fn apply_key_to_music_metadata(metadata: &mut MusicMetadata, analysis: &AudioAnalysis) -> bool {
    if metadata.key.is_some() {
        return false;
    }
    let Some(key) = analysis
        .key
        .as_ref()
        .filter(|key| key.confidence >= KEY_AUTO_ACCEPT_CONFIDENCE)
    else {
        return false;
    };
    metadata.key = Some(key.primary.clone());
    metadata.camelot = Some(key.camelot.clone());
    metadata.confidence = metadata.confidence.max(key.confidence);
    metadata.matches.push(key_analysis_match(key));
    true
}

pub fn apply_key_to_final_metadata(metadata: &mut FinalMetadata, analysis: &AudioAnalysis) -> bool {
    if metadata.key.is_some() {
        return false;
    }
    let Some(key) = analysis
        .key
        .as_ref()
        .filter(|key| key.confidence >= KEY_AUTO_ACCEPT_CONFIDENCE)
    else {
        return false;
    };
    metadata.key = Some(key.primary.clone());
    metadata.camelot = Some(key.camelot.clone());
    metadata.evidence.push(key_analysis_match(key));
    true
}

fn analysis_match(tempo: &TempoEstimate) -> MetadataMatch {
    MetadataMatch {
        kind: "bpm".into(),
        display_value: format!("{} BPM", tempo.primary),
        raw_text: "Detected from the audio signal".into(),
        source: "audioAnalysis".into(),
        confidence: tempo.confidence,
    }
}

fn key_analysis_match(key: &KeyEstimate) -> MetadataMatch {
    MetadataMatch {
        kind: "key".into(),
        display_value: format!("{} ({})", key.primary, key.camelot),
        raw_text: "Detected from the audio signal".into(),
        source: "audioAnalysis".into(),
        confidence: key.confidence,
    }
}

pub fn analyze_key_samples(samples: &[f32], sample_rate: u32) -> Option<KeyEstimate> {
    const FFT_SIZE: usize = 4_096;
    const HOP_SIZE: usize = FFT_SIZE / 2;
    const NOTE_NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    const MAJOR_PROFILE: [f64; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MINOR_PROFILE: [f64; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];

    if sample_rate == 0 || samples.len() < FFT_SIZE * 2 {
        return None;
    }
    let bounded = &samples[..samples
        .len()
        .min(sample_rate as usize * MAX_ANALYSIS_SECONDS)];
    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut chroma = [0.0_f64; 12];
    let mut frames = 0_u64;
    for start in (0..=bounded.len().saturating_sub(FFT_SIZE)).step_by(HOP_SIZE) {
        let mut buffer = bounded[start..start + FFT_SIZE]
            .iter()
            .enumerate()
            .map(|(index, sample)| {
                let window = 0.5
                    - 0.5 * (std::f64::consts::TAU * index as f64 / (FFT_SIZE - 1) as f64).cos();
                Complex::new(
                    f64::from(if sample.is_finite() { *sample } else { 0.0 }) * window,
                    0.0,
                )
            })
            .collect::<Vec<_>>();
        fft.process(&mut buffer);
        for (bin, value) in buffer.iter().enumerate().take(FFT_SIZE / 2).skip(1) {
            let frequency = bin as f64 * f64::from(sample_rate) / FFT_SIZE as f64;
            if !(55.0..=1_800.0).contains(&frequency) {
                continue;
            }
            let midi = (69.0 + 12.0 * (frequency / 440.0).log2()).round() as i32;
            let pitch_class = midi.rem_euclid(12) as usize;
            chroma[pitch_class] += value.norm_sqr().sqrt();
        }
        frames += 1;
    }
    let total = chroma.iter().sum::<f64>();
    if frames == 0 || !total.is_finite() || total <= 1e-8 {
        return None;
    }
    for value in &mut chroma {
        *value /= total;
    }
    let score = |tonic: usize, profile: &[f64; 12]| {
        let numerator = (0..12)
            .map(|pitch| chroma[pitch] * profile[(pitch + 12 - tonic) % 12])
            .sum::<f64>();
        let left = chroma.iter().map(|value| value * value).sum::<f64>().sqrt();
        let right = profile
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt();
        numerator / (left * right).max(1e-12)
    };
    let mut candidates = (0..12)
        .flat_map(|tonic| {
            [
                (tonic, false, score(tonic, &MAJOR_PROFILE)),
                (tonic, true, score(tonic, &MINOR_PROFILE)),
            ]
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.2.total_cmp(&left.2));
    let (tonic, minor, best_score) = candidates[0];
    let second_score = candidates.get(1).map_or(0.0, |candidate| candidate.2);
    let separation = ((best_score - second_score) / best_score.max(1e-9)).clamp(0.0, 1.0);
    let confidence = (0.08 + best_score * 0.82 + separation * 1.8).clamp(0.0, 1.0);
    if confidence < 0.35 {
        return None;
    }
    let primary = format!(
        "{} {}",
        NOTE_NAMES[tonic],
        if minor { "minor" } else { "major" }
    );
    Some(KeyEstimate {
        primary,
        camelot: camelot_for(tonic, minor).into(),
        confidence,
    })
}

fn camelot_for(tonic: usize, minor: bool) -> &'static str {
    const MAJOR: [&str; 12] = [
        "8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B",
    ];
    const MINOR: [&str; 12] = [
        "5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A",
    ];
    if minor {
        MINOR[tonic]
    } else {
        MAJOR[tonic]
    }
}

pub fn analyze_tempo_samples(samples: &[f32], sample_rate: u32) -> Option<TempoEstimate> {
    if sample_rate == 0 {
        return None;
    }
    let sample_rate = sample_rate as usize;
    let minimum_samples = sample_rate.saturating_mul(MIN_ANALYSIS_SECONDS);
    if samples.len() < minimum_samples {
        return None;
    }
    let bounded = &samples[..samples
        .len()
        .min(sample_rate.saturating_mul(MAX_ANALYSIS_SECONDS))];
    let frame_size = (sample_rate / ONSET_FRAMES_PER_SECOND).max(1);
    let mut energy = Vec::with_capacity(bounded.len() / frame_size);
    for frame in bounded.chunks_exact(frame_size) {
        let sum = frame
            .iter()
            .map(|sample| {
                let value = if sample.is_finite() { *sample } else { 0.0 };
                f64::from(value) * f64::from(value)
            })
            .sum::<f64>();
        energy.push((sum / frame.len() as f64).sqrt().ln_1p());
    }
    if energy.len() < ONSET_FRAMES_PER_SECOND * MIN_ANALYSIS_SECONDS {
        return None;
    }
    let mut onset = vec![0.0_f64; energy.len()];
    for index in 1..energy.len() {
        onset[index] = (energy[index] - energy[index - 1]).max(0.0);
    }
    let onset_power = onset.iter().map(|value| value * value).sum::<f64>();
    if !onset_power.is_finite() || onset_power <= 1e-8 {
        return None;
    }

    let minimum_lag = (ONSET_FRAMES_PER_SECOND * 60 / 200).max(1);
    let maximum_lag = (ONSET_FRAMES_PER_SECOND * 60 / 60).min(onset.len() / 2);
    let mut scores = Vec::with_capacity(maximum_lag.saturating_sub(minimum_lag) + 1);
    for lag in minimum_lag..=maximum_lag {
        let mut product = 0.0;
        let mut left_power = 0.0;
        let mut right_power = 0.0;
        for index in lag..onset.len() {
            let left = onset[index];
            let right = onset[index - lag];
            product += left * right;
            left_power += left * left;
            right_power += right * right;
        }
        let denominator = (left_power * right_power).sqrt();
        let score = if denominator > 1e-12 {
            (product / denominator).clamp(0.0, 1.0)
        } else {
            0.0
        };
        scores.push((lag, score));
    }
    let raw_score = |lag: usize| {
        scores
            .get(lag.saturating_sub(minimum_lag))
            .filter(|(stored_lag, _)| *stored_lag == lag)
            .map(|(_, score)| *score)
    };
    let ranked = scores
        .iter()
        .map(|(lag, score)| {
            let mut weighted = *score;
            let mut weight = 1.0;
            if let Some(harmonic) = raw_score(lag * 2) {
                weighted += harmonic * 0.5;
                weight += 0.5;
            }
            if let Some(harmonic) = raw_score(lag * 3) {
                weighted += harmonic * 0.25;
                weight += 0.25;
            }
            (*lag, weighted / weight)
        })
        .collect::<Vec<_>>();
    let &(mut best_lag, mut best_score) = ranked.iter().reduce(|best, candidate| {
        if candidate.1 > best.1 + 1e-9
            || ((candidate.1 - best.1).abs() <= 1e-9 && candidate.0 < best.0)
        {
            candidate
        } else {
            best
        }
    })?;
    // Long autocorrelation lags can dominate when every second or third beat aligns
    // perfectly. Prefer a supported faster pulse only when the initially selected
    // tempo is unusually slow and the faster candidate has strong direct evidence.
    let mut harmonic_promotion = false;
    if 60.0 * ONSET_FRAMES_PER_SECOND as f64 / (best_lag as f64) < 70.0 {
        for divisor in [3, 2] {
            let target_lag = best_lag / divisor;
            let Some((candidate_lag, candidate_raw_score)) = (target_lag.saturating_sub(2)
                ..=target_lag.saturating_add(2))
                .filter_map(|lag| raw_score(lag).map(|score| (lag, score)))
                .max_by(|left, right| left.1.total_cmp(&right.1))
            else {
                continue;
            };
            if candidate_raw_score >= best_score * 0.55 {
                best_lag = candidate_lag;
                best_score = ranked
                    .iter()
                    .find(|(lag, _)| *lag == candidate_lag)
                    .map_or(candidate_raw_score, |(_, score)| *score);
                harmonic_promotion = true;
                break;
            }
        }
    }
    if best_score < 0.15 {
        return None;
    }
    let second_score = ranked
        .iter()
        .filter(|(lag, _)| lag.abs_diff(best_lag) > 2)
        .map(|(_, score)| *score)
        .max_by(f64::total_cmp)
        .unwrap_or(0.0);
    let separation = ((best_score - second_score) / best_score.max(1e-9)).clamp(0.0, 1.0);
    let duration_factor = (bounded.len() as f64 / sample_rate as f64 / 30.0).clamp(0.4, 1.0);
    let confidence = ((best_score.powf(0.4) * 0.9 + separation * 0.1)
        + if harmonic_promotion { 0.05 } else { 0.0 })
        * duration_factor;
    let best_index = best_lag.saturating_sub(minimum_lag);
    let refined_lag = if best_index > 0 && best_index + 1 < scores.len() {
        let previous = scores[best_index - 1].1;
        let current = scores[best_index].1;
        let next = scores[best_index + 1].1;
        let denominator = previous - 2.0 * current + next;
        let offset = if denominator.abs() > 1e-9 {
            (0.5 * (previous - next) / denominator).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        best_lag as f64 + offset
    } else {
        best_lag as f64
    };
    let primary = round_bpm(60.0 * ONSET_FRAMES_PER_SECOND as f64 / refined_lag);
    let mut alternates = [primary / 2.0, primary * 2.0]
        .into_iter()
        .filter(|value| (20.0..=400.0).contains(value))
        .map(round_bpm)
        .collect::<Vec<_>>();
    alternates.dedup_by(|left, right| (*left - *right).abs() < 0.01);

    Some(TempoEstimate {
        primary,
        alternates,
        confidence: confidence.clamp(0.0, 1.0),
    })
}

fn round_bpm(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_track(bpm: f64, seconds: usize, sample_rate: u32) -> Vec<f32> {
        let sample_count = seconds * sample_rate as usize;
        let samples_per_beat = (60.0 * f64::from(sample_rate) / bpm).round() as usize;
        let mut samples = vec![0.0_f32; sample_count];
        for beat in (0..sample_count).step_by(samples_per_beat.max(1)) {
            for offset in 0..(sample_rate as usize / 100).max(1) {
                if let Some(sample) = samples.get_mut(beat + offset) {
                    *sample = 1.0 - offset as f32 / (sample_rate as f32 / 100.0).max(1.0);
                }
            }
        }
        samples
    }

    #[test]
    fn estimates_stable_click_tracks_with_high_confidence() {
        for expected in [72.0, 90.0, 120.0, 128.0, 144.0, 180.0] {
            let estimate = analyze_tempo_samples(&click_track(expected, 30, 1_000), 1_000)
                .unwrap_or_else(|| panic!("no estimate for {expected} BPM"));
            let matches_primary = (estimate.primary - expected).abs() <= 1.0;
            let matches_alternate = estimate
                .alternates
                .iter()
                .any(|value| (*value - expected).abs() <= 1.0);
            assert!(
                matches_primary || matches_alternate,
                "expected {expected}, got {estimate:?}"
            );
            assert!(
                estimate.confidence >= AUTO_ACCEPT_CONFIDENCE,
                "confidence too low for {expected}: {estimate:?}"
            );
        }
    }

    #[test]
    fn rejects_silence_short_audio_and_non_finite_samples() {
        assert!(analyze_tempo_samples(&vec![0.0; 30_000], 1_000).is_none());
        assert!(analyze_tempo_samples(&vec![1.0; 2_000], 1_000).is_none());
        assert!(analyze_tempo_samples(&vec![f32::NAN; 30_000], 1_000).is_none());
        assert!(analyze_tempo_samples(&[], 0).is_none());
    }

    #[test]
    fn estimates_are_finite_and_bounded() {
        let estimate = analyze_tempo_samples(&click_track(120.0, 30, 1_000), 1_000).unwrap();
        assert!((20.0..=400.0).contains(&estimate.primary));
        assert!((0.0..=1.0).contains(&estimate.confidence));
        assert!(estimate
            .alternates
            .iter()
            .all(|value| value.is_finite() && (20.0..=400.0).contains(value)));
    }

    #[test]
    fn detected_tempo_only_fills_blank_metadata_at_the_threshold() {
        let analysis = AudioAnalysis {
            source_sha256: "a".repeat(64),
            analyzer_version: ANALYZER_VERSION.into(),
            analyzed_duration_ms: 30_000,
            bpm: Some(TempoEstimate {
                primary: 128.0,
                alternates: vec![64.0, 256.0],
                confidence: AUTO_ACCEPT_CONFIDENCE,
            }),
            key: None,
            warnings: vec![],
        };
        let mut blank = FinalMetadata::default();
        assert!(apply_to_final_metadata(&mut blank, &analysis));
        assert_eq!(blank.bpm, Some(128.0));

        let mut manual = FinalMetadata {
            bpm: Some(140.0),
            ..Default::default()
        };
        assert!(!apply_to_final_metadata(&mut manual, &analysis));
        assert_eq!(manual.bpm, Some(140.0));

        let mut low = FinalMetadata::default();
        let mut low_analysis = analysis;
        low_analysis.bpm.as_mut().unwrap().confidence = AUTO_ACCEPT_CONFIDENCE - 0.01;
        assert!(!apply_to_final_metadata(&mut low, &low_analysis));
        assert_eq!(low.bpm, None);
    }

    #[test]
    fn detects_major_and_minor_chords_with_camelot_labels() {
        fn chord(frequencies: &[f64]) -> Vec<f32> {
            let sample_rate = 4_000.0;
            (0..(sample_rate as usize * 12))
                .map(|index| {
                    frequencies
                        .iter()
                        .map(|frequency| {
                            (std::f64::consts::TAU * frequency * index as f64 / sample_rate).sin()
                        })
                        .sum::<f64>() as f32
                        / frequencies.len() as f32
                })
                .collect()
        }

        let c_major = analyze_key_samples(&chord(&[261.63, 329.63, 392.0]), 4_000).unwrap();
        assert_eq!(c_major.primary, "C major");
        assert_eq!(c_major.camelot, "8B");
        assert!(
            c_major.confidence >= KEY_AUTO_ACCEPT_CONFIDENCE,
            "{c_major:?}"
        );

        let a_minor = analyze_key_samples(&chord(&[220.0, 261.63, 329.63]), 4_000).unwrap();
        assert_eq!(a_minor.primary, "A minor");
        assert_eq!(a_minor.camelot, "8A");
        assert!(
            a_minor.confidence >= KEY_AUTO_ACCEPT_CONFIDENCE,
            "{a_minor:?}"
        );
    }
}
