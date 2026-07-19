use std::{cmp::Ordering, sync::OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicMetadata {
    pub bpm: Option<f64>,
    pub alternate_bpms: Vec<f64>,
    pub key: Option<String>,
    pub camelot: Option<String>,
    pub detune_cents: Option<f64>,
    pub tuning_hz: Option<f64>,
    pub confidence: f64,
    pub matches: Vec<MetadataMatch>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataMatch {
    pub kind: String,
    pub display_value: String,
    pub raw_text: String,
    pub source: String,
    pub confidence: f64,
}

#[derive(Clone, Debug)]
struct Candidate<T> {
    value: T,
    display: String,
    raw: String,
    source: &'static str,
    score: f64,
}

#[derive(Clone, Debug)]
struct TempoCandidate {
    candidate: Candidate<f64>,
    alternates: Vec<f64>,
}

#[derive(Clone, Debug)]
struct KeyValue {
    display: String,
    camelot: Option<String>,
}

pub fn parse_music_metadata(title: &str, description: &str) -> MusicMetadata {
    let mut tempos = Vec::new();
    let mut keys = Vec::new();
    let mut detunes = Vec::new();
    let mut tunings = Vec::new();

    for (source, text, base_score) in [("description", description, 0.98), ("title", title, 0.94)] {
        for raw in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let normalized = normalize_symbols(raw);
            collect_tempos(&normalized, raw, source, base_score, &mut tempos);
            collect_keys(&normalized, raw, source, base_score, &mut keys);
            collect_tuning(&normalized, raw, source, base_score, &mut tunings);
            collect_detune(&normalized, raw, source, base_score, &mut detunes);
        }
    }

    // Compact producer titles commonly use separators without KEY/SCALE labels.
    collect_title_key(title, &mut keys);

    sort_candidates(&mut tempos, |item| item.candidate.score);
    sort_candidates(&mut keys, |item| item.score);
    sort_candidates(&mut detunes, |item| item.score);
    sort_candidates(&mut tunings, |item| item.score);

    let mut result = MusicMetadata::default();
    let mut selected_scores = Vec::new();

    if let Some(selected) = tempos.first() {
        result.bpm = Some(selected.candidate.value);
        result.alternate_bpms = selected.alternates.clone();
        selected_scores.push(selected.candidate.score);
        result.matches.push(as_match("bpm", &selected.candidate));
        if !selected.alternates.is_empty() {
            result
                .warnings
                .push("Multiple or half-time tempo values were declared".to_string());
        }
        if tempos
            .iter()
            .skip(1)
            .any(|candidate| !tempo_equivalent(candidate.candidate.value, selected.candidate.value))
        {
            result.warnings.push(
                "Conflicting BPM values were found; the strongest labelled match is shown"
                    .to_string(),
            );
        }
    }

    if let Some(selected) = keys.first() {
        result.key = Some(selected.value.display.clone());
        result.camelot = selected.value.camelot.clone();
        selected_scores.push(selected.score);
        result.matches.push(as_match("key", selected));
        if keys
            .iter()
            .skip(1)
            .any(|candidate| candidate.value.display != selected.value.display)
        {
            result.warnings.push(
                "Conflicting key values were found; the strongest labelled match is shown"
                    .to_string(),
            );
        }
    }

    if let Some(selected) = tunings.first() {
        result.tuning_hz = Some(selected.value);
        let cents = hz_to_cents(selected.value);
        result.detune_cents = Some(cents);
        selected_scores.push(selected.score);
        result.matches.push(as_match("tuning", selected));
    }

    if let Some(selected) = detunes.first() {
        if result.tuning_hz.is_none()
            || selected.score >= tunings.first().map_or(0.0, |item| item.score)
        {
            result.detune_cents = Some(selected.value);
        }
        selected_scores.push(selected.score);
        result.matches.push(as_match("detune", selected));
        if let Some(tuning) = tunings.first() {
            if (hz_to_cents(tuning.value) - selected.value).abs() > 5.0 {
                result
                    .warnings
                    .push("The declared tuning frequency and cents value do not agree".to_string());
            }
        }
    }

    result.confidence = if selected_scores.is_empty() {
        0.0
    } else {
        (selected_scores.iter().sum::<f64>() / selected_scores.len() as f64).clamp(0.0, 1.0)
    };
    result
}

fn collect_tempos(
    normalized: &str,
    raw: &str,
    source: &'static str,
    base_score: f64,
    output: &mut Vec<TempoCandidate>,
) {
    for captures in bpm_label_regex().captures_iter(normalized) {
        add_tempo_capture(&captures, raw, source, base_score, output);
    }
    for captures in bpm_suffix_regex().captures_iter(normalized) {
        add_tempo_capture(&captures, raw, source, base_score - 0.01, output);
    }
}

fn add_tempo_capture(
    captures: &regex::Captures<'_>,
    raw: &str,
    source: &'static str,
    score: f64,
    output: &mut Vec<TempoCandidate>,
) {
    let Some(primary) = captures
        .name("first")
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .filter(valid_bpm)
    else {
        return;
    };
    let alternates = captures
        .name("second")
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .filter(valid_bpm)
        .filter(|value| (*value - primary).abs() > 0.05)
        .into_iter()
        .collect::<Vec<_>>();
    let display = alternates.first().map_or_else(
        || format!("{} BPM", number(primary)),
        |alternate| format!("{}/{} BPM", number(primary), number(*alternate)),
    );
    push_unique_tempo(
        output,
        TempoCandidate {
            candidate: Candidate {
                value: primary,
                display,
                raw: raw.to_string(),
                source,
                score,
            },
            alternates,
        },
    );
}

fn collect_keys(
    normalized: &str,
    raw: &str,
    source: &'static str,
    base_score: f64,
    output: &mut Vec<Candidate<KeyValue>>,
) {
    let mut labelled_match = false;
    for captures in key_label_regex().captures_iter(normalized) {
        let Some(value) = key_from_captures(&captures) else {
            continue;
        };
        labelled_match = true;
        push_unique(
            output,
            Candidate {
                display: value.display.clone(),
                value,
                raw: raw.to_string(),
                source,
                score: base_score,
            },
            |left, right| left.value.display == right.value.display && left.source == right.source,
        );
    }

    // Accept compact producer metadata such as `140 BPM | C#m`, while
    // avoiding unlabelled chord names in ordinary description prose.
    if !labelled_match && normalized.to_ascii_lowercase().contains("bpm") {
        for captures in compact_key_regex().captures_iter(normalized) {
            let Some(value) = key_from_captures(&captures) else {
                continue;
            };
            push_unique(
                output,
                Candidate {
                    display: value.display.clone(),
                    value,
                    raw: raw.to_string(),
                    source,
                    score: base_score - 0.14,
                },
                |left, right| {
                    left.value.display == right.value.display && left.source == right.source
                },
            );
        }
    }
}

fn collect_title_key(title: &str, output: &mut Vec<Candidate<KeyValue>>) {
    let normalized = normalize_symbols(title);
    for captures in compact_key_regex().captures_iter(&normalized) {
        let Some(value) = key_from_captures(&captures) else {
            continue;
        };
        push_unique(
            output,
            Candidate {
                display: value.display.clone(),
                value,
                raw: title.trim().to_string(),
                source: "title",
                score: 0.82,
            },
            |left, right| left.value.display == right.value.display && left.source == right.source,
        );
    }
}

fn collect_tuning(
    normalized: &str,
    raw: &str,
    source: &'static str,
    base_score: f64,
    output: &mut Vec<Candidate<f64>>,
) {
    for captures in tuning_regex().captures_iter(normalized) {
        let Some(hz) = captures
            .name("hz")
            .and_then(|value| value.as_str().parse::<f64>().ok())
            .filter(|value| (400.0..=480.0).contains(value))
        else {
            continue;
        };
        push_unique(
            output,
            Candidate {
                value: hz,
                display: format!("A={} Hz ({:+.1}c)", number(hz), hz_to_cents(hz)),
                raw: raw.to_string(),
                source,
                score: base_score,
            },
            |left, right| (left.value - right.value).abs() < 0.01,
        );
    }

    // A bare 432Hz/440Hz is common producer shorthand, but is less certain.
    for captures in bare_tuning_regex().captures_iter(normalized) {
        let Some(hz) = captures
            .name("hz")
            .and_then(|value| value.as_str().parse::<f64>().ok())
            .filter(|value| (400.0..=480.0).contains(value))
        else {
            continue;
        };
        push_unique(
            output,
            Candidate {
                value: hz,
                display: format!("A={} Hz ({:+.1}c)", number(hz), hz_to_cents(hz)),
                raw: raw.to_string(),
                source,
                score: if source == "title" { 0.80 } else { 0.76 },
            },
            |left, right| (left.value - right.value).abs() < 0.01,
        );
    }
}

fn collect_detune(
    normalized: &str,
    raw: &str,
    source: &'static str,
    base_score: f64,
    output: &mut Vec<Candidate<f64>>,
) {
    for captures in cents_regex().captures_iter(normalized) {
        let Some(value) = captures
            .name("amount")
            .and_then(|amount| amount.as_str().parse::<f64>().ok())
            .map(|amount| apply_direction(amount, normalized))
            .filter(|amount| amount.abs() <= 1_200.0)
        else {
            continue;
        };
        push_detune(output, value, raw, source, base_score);
    }

    for captures in semitone_regex().captures_iter(normalized) {
        let Some(value) = captures
            .name("amount")
            .and_then(|amount| amount.as_str().parse::<f64>().ok())
            .map(|amount| apply_direction(amount * 100.0, normalized))
            .filter(|amount| amount.abs() <= 1_200.0)
        else {
            continue;
        };
        push_detune(output, value, raw, source, base_score - 0.01);
    }

    for captures in bare_detune_regex().captures_iter(normalized) {
        let Some(value) = captures
            .name("amount")
            .and_then(|amount| amount.as_str().parse::<f64>().ok())
            .map(|amount| apply_direction(amount, normalized))
            .filter(|amount| amount.abs() <= 100.0)
        else {
            continue;
        };
        push_detune(output, value, raw, source, base_score - 0.12);
    }

    if half_step_regex().is_match(normalized) {
        let value = if contains_down(normalized) {
            -100.0
        } else {
            100.0
        };
        push_detune(output, value, raw, source, base_score - 0.01);
    }
}

fn push_detune(
    output: &mut Vec<Candidate<f64>>,
    value: f64,
    raw: &str,
    source: &'static str,
    score: f64,
) {
    push_unique(
        output,
        Candidate {
            value,
            display: format!("{value:+.1}c"),
            raw: raw.to_string(),
            source,
            score,
        },
        |left, right| (left.value - right.value).abs() < 0.01,
    );
}

fn key_from_captures(captures: &regex::Captures<'_>) -> Option<KeyValue> {
    let root = captures.name("root")?.as_str().to_ascii_uppercase();
    let accidental = captures
        .name("accidental")
        .map(|value| match value.as_str().to_ascii_lowercase().as_str() {
            "sharp" | "#" => "#",
            "flat" | "b" => "b",
            _ => "",
        })
        .unwrap_or_default();
    let tonic = format!("{root}{accidental}");
    let raw_mode = captures
        .name("mode")
        .map(|value| value.as_str().to_ascii_lowercase())
        .unwrap_or_default();
    let mode = match raw_mode.as_str() {
        "m" | "min" | "minor" => "minor",
        "maj" | "major" => "major",
        "ionian" => "Ionian",
        "aeolian" => "Aeolian",
        "dorian" => "Dorian",
        "phrygian" => "Phrygian",
        "lydian" => "Lydian",
        "mixolydian" => "Mixolydian",
        "locrian" => "Locrian",
        "" => "",
        _ => return None,
    };
    let display = if mode.is_empty() {
        tonic.clone()
    } else {
        format!("{tonic} {mode}")
    };
    let camelot_mode = match mode {
        "minor" | "Aeolian" => Some(false),
        "major" | "Ionian" => Some(true),
        _ => None,
    };
    Some(KeyValue {
        display,
        camelot: camelot_mode.and_then(|major| camelot_for(&tonic, major)),
    })
}

fn camelot_for(tonic: &str, major: bool) -> Option<String> {
    let pitch = match tonic {
        "Cb" => "B",
        "B#" => "C",
        "Db" => "C#",
        "D#" => "Eb",
        "E#" => "F",
        "Gb" => "F#",
        "G#" => "Ab",
        "A#" => "Bb",
        _ => tonic,
    };
    let table = if major {
        [
            ("B", "1B"),
            ("F#", "2B"),
            ("C#", "3B"),
            ("Ab", "4B"),
            ("Eb", "5B"),
            ("Bb", "6B"),
            ("F", "7B"),
            ("C", "8B"),
            ("G", "9B"),
            ("D", "10B"),
            ("A", "11B"),
            ("E", "12B"),
        ]
    } else {
        [
            ("Ab", "1A"),
            ("Eb", "2A"),
            ("Bb", "3A"),
            ("F", "4A"),
            ("C", "5A"),
            ("G", "6A"),
            ("D", "7A"),
            ("A", "8A"),
            ("E", "9A"),
            ("B", "10A"),
            ("F#", "11A"),
            ("C#", "12A"),
        ]
    };
    table
        .iter()
        .find(|(candidate, _)| *candidate == pitch)
        .map(|(_, code)| (*code).to_string())
}

fn as_match<T>(kind: &str, candidate: &Candidate<T>) -> MetadataMatch {
    MetadataMatch {
        kind: kind.to_string(),
        display_value: candidate.display.clone(),
        raw_text: candidate.raw.clone(),
        source: candidate.source.to_string(),
        confidence: candidate.score,
    }
}

fn push_unique<T, F>(items: &mut Vec<Candidate<T>>, candidate: Candidate<T>, equal: F)
where
    F: Fn(&Candidate<T>, &Candidate<T>) -> bool,
{
    if !items.iter().any(|item| equal(item, &candidate)) {
        items.push(candidate);
    }
}

fn push_unique_tempo(items: &mut Vec<TempoCandidate>, candidate: TempoCandidate) {
    if !items.iter().any(|item| {
        (item.candidate.value - candidate.candidate.value).abs() < 0.01
            && item.candidate.source == candidate.candidate.source
            && item.alternates == candidate.alternates
    }) {
        items.push(candidate);
    }
}

fn sort_candidates<T, F>(items: &mut [T], score: F)
where
    F: Fn(&T) -> f64,
{
    items.sort_by(|left, right| {
        score(right)
            .partial_cmp(&score(left))
            .unwrap_or(Ordering::Equal)
    });
}

fn valid_bpm(value: &f64) -> bool {
    value.is_finite() && (30.0..=320.0).contains(value)
}

fn tempo_equivalent(left: f64, right: f64) -> bool {
    (left - right).abs() < 0.1
        || (left * 2.0 - right).abs() < 0.1
        || (right * 2.0 - left).abs() < 0.1
}

fn contains_down(text: &str) -> bool {
    ["down", "lower", "flat"]
        .iter()
        .any(|word| text.contains(word))
}

fn apply_direction(value: f64, context: &str) -> f64 {
    if value.is_sign_negative() {
        value
    } else if contains_down(context) {
        -value
    } else {
        value
    }
}

fn hz_to_cents(hz: f64) -> f64 {
    1_200.0 * (hz / 440.0).log2()
}

fn number(value: f64) -> String {
    if value.fract().abs() < 0.001 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

fn normalize_symbols(value: &str) -> String {
    value
        .replace(['♯', '＃'], "#")
        .replace(['♭', '♬'], "b")
        .replace(['–', '—', '−'], "-")
}

fn regex(slot: &'static OnceLock<Regex>, expression: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(expression).expect("metadata regex must be valid"))
}

fn bpm_label_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)\b(?:bpm|tempo)\s*[:=\-]?\s*(?P<first>\d{2,3}(?:\.\d+)?)(?:\s*[/|]\s*(?P<second>\d{2,3}(?:\.\d+)?))?",
    )
}

fn bpm_suffix_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)\b(?P<first>\d{2,3}(?:\.\d+)?)(?:\s*[/|]\s*(?P<second>\d{2,3}(?:\.\d+)?))?\s*bpm\b",
    )
}

fn key_label_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)\b(?:key|scale)\s*[:=\-]?\s*(?P<root>[a-g])\s*(?P<accidental>#|b|sharp|flat)?\s*(?P<mode>major|minor|maj|min|m|ionian|aeolian|dorian|phrygian|lydian|mixolydian|locrian)?\b",
    )
}

fn compact_key_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)(?:^|[\[\](){}/|,;:\-])\s*(?P<root>[a-g])\s*(?P<accidental>#|b|sharp|flat)?\s*(?P<mode>major|minor|maj|min|m|ionian|aeolian|dorian|phrygian|lydian|mixolydian|locrian)\b",
    )
}

fn tuning_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)(?:\bA\s*=\s*|\btun(?:ed|ing)\s*(?:to|at|:|=)?\s*)(?P<hz>\d{3}(?:\.\d+)?)\s*hz\b",
    )
}

fn bare_tuning_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(&VALUE, r"(?i)\b(?P<hz>4\d{2}(?:\.\d+)?)\s*hz\b")
}

fn cents_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)(?P<amount>[+\-]?\d+(?:\.\d+)?)\s*(?:(?:cents?|cts?|c)\b|¢)",
    )
}

fn semitone_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)(?P<amount>[+\-]?\d+(?:\.\d+)?)\s*(?:semitones?|st)\b",
    )
}

fn bare_detune_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(
        &VALUE,
        r"(?i)\bdetun(?:e|ed|ing)\s*[:=]?\s*(?P<amount>[+\-]?\d+(?:\.\d+)?)\b",
    )
}

fn half_step_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    regex(&VALUE, r"(?i)\bhalf(?:[ -]?|\s+a\s+)step\s*(?:up|down)?\b")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_compact_description_labels() {
        let parsed = parse_music_metadata("A beat", "Genre: Trap\nKEY: Cm BPM: 150");
        assert_eq!(parsed.bpm, Some(150.0));
        assert_eq!(parsed.key.as_deref(), Some("C minor"));
        assert_eq!(parsed.camelot.as_deref(), Some("5A"));
        assert!(parsed.confidence > 0.95);
    }

    #[test]
    fn parses_unicode_key_decimal_bpm_and_432_tuning() {
        let parsed = parse_music_metadata(
            "Producer beat",
            "BPM: 139.5\nScale: F♯ minor\nTuning: A=432Hz",
        );
        assert_eq!(parsed.bpm, Some(139.5));
        assert_eq!(parsed.key.as_deref(), Some("F# minor"));
        assert_eq!(parsed.camelot.as_deref(), Some("11A"));
        assert_eq!(parsed.tuning_hz, Some(432.0));
        assert!((parsed.detune_cents.unwrap() + 31.766).abs() < 0.1);
    }

    #[test]
    fn preserves_half_time_alternative() {
        let parsed = parse_music_metadata("Beat", "Tempo: 70/140\nKey: D minor");
        assert_eq!(parsed.bpm, Some(70.0));
        assert_eq!(parsed.alternate_bpms, vec![140.0]);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("tempo")));
    }

    #[test]
    fn parses_directional_detune_and_semitones() {
        let cents = parse_music_metadata("Beat", "Key: D minor\n50 cents down");
        assert_eq!(cents.detune_cents, Some(-50.0));
        let compact_cents = parse_music_metadata("Beat", "50c down");
        assert_eq!(compact_cents.detune_cents, Some(-50.0));
        let semitone = parse_music_metadata("Beat", "Pitch +1 semitone");
        assert_eq!(semitone.detune_cents, Some(100.0));
        let half_step = parse_music_metadata("Beat", "pitched half-step down");
        assert_eq!(half_step.detune_cents, Some(-100.0));
        let half_a_step = parse_music_metadata("Beat", "pitched down half a step");
        assert_eq!(half_a_step.detune_cents, Some(-100.0));
    }

    #[test]
    fn reads_compact_title_key_without_false_description_guessing() {
        let parsed = parse_music_metadata(
            "[FREE] Dark Type Beat | 144 BPM | C#m",
            "0:00 Intro\n0:32 Verse\n© 2026",
        );
        assert_eq!(parsed.bpm, Some(144.0));
        assert_eq!(parsed.key.as_deref(), Some("C# minor"));
        assert_eq!(parsed.camelot.as_deref(), Some("12A"));
    }

    #[test]
    fn does_not_treat_timestamps_years_or_bitrates_as_metadata() {
        let parsed = parse_music_metadata(
            "Untitled instrumental",
            "0:00 intro\n1:40 hook\nCopyright 2026\nDownload 320kbps",
        );
        assert_eq!(parsed.bpm, None);
        assert_eq!(parsed.key, None);
        assert_eq!(parsed.tuning_hz, None);
    }

    #[test]
    fn reports_conflicting_labelled_values() {
        let parsed = parse_music_metadata("Beat", "BPM: 140\nBPM: 152\nKey: A minor\nKey: E minor");
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("Conflicting BPM")));
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("Conflicting key")));
    }

    #[test]
    fn maps_flat_major_key_to_camelot() {
        let parsed = parse_music_metadata("Beat", "Key: Db major");
        assert_eq!(parsed.key.as_deref(), Some("Db major"));
        assert_eq!(parsed.camelot.as_deref(), Some("3B"));
    }

    #[test]
    fn tuning_and_explicit_cents_disagreement_is_visible() {
        let parsed = parse_music_metadata("Beat", "A=432Hz\nDetuned -50 cents");
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("do not agree")));
    }

    #[test]
    fn parses_compact_description_key_and_bare_tuning() {
        let parsed = parse_music_metadata("Beat", "140 BPM | C#m\n432Hz");
        assert_eq!(parsed.key.as_deref(), Some("C# minor"));
        assert_eq!(parsed.tuning_hz, Some(432.0));
    }

    #[test]
    fn parses_cent_symbol_and_unitless_detune_label() {
        let symbol = parse_music_metadata("Beat", "Detuned 37¢ down");
        assert_eq!(symbol.detune_cents, Some(-37.0));
        let labelled = parse_music_metadata("Beat", "detune: -42");
        assert_eq!(labelled.detune_cents, Some(-42.0));
    }

    #[test]
    fn parses_bracketed_master_pitch_from_producer_descriptions() {
        let parsed = parse_music_metadata(
            "[FREE] Detuned Type Beat",
            "[ KEY: F# MINOR ] | [ MASTER PITCH: -300 cents ] | [ TEMPO: 105 BPM ]",
        );
        assert_eq!(parsed.bpm, Some(105.0));
        assert_eq!(parsed.key.as_deref(), Some("F# minor"));
        assert_eq!(parsed.camelot.as_deref(), Some("11A"));
        assert_eq!(parsed.detune_cents, Some(-300.0));
    }
}
