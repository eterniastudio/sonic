use std::path::Path;

use crate::{
    error::{invalid, AppResult},
    models::{ChannelMode, ExportPreset, ExportPresetId, ExportSpec, FinalMetadata},
};

pub fn export_presets() -> Vec<ExportPreset> {
    vec![
        preset(
            ExportPresetId::Original,
            "Original stream",
            "Preserves the acquired audio stream without claiming a quality increase.",
            None,
            false,
            false,
        ),
        preset(
            ExportPresetId::Mp3V0,
            "MP3 V0",
            "High-quality variable bitrate MP3.",
            Some("mp3"),
            true,
            true,
        ),
        preset(
            ExportPresetId::Mp3Cbr320,
            "MP3 320 kbps",
            "Constant 320 kbps MP3 for broad DAW compatibility.",
            Some("mp3"),
            true,
            true,
        ),
        preset(
            ExportPresetId::M4aAac256,
            "M4A AAC 256 kbps",
            "Efficient AAC audio at 256 kbps.",
            Some("m4a"),
            true,
            true,
        ),
        preset(
            ExportPresetId::Wav44100S24,
            "WAV 44.1 kHz / 24-bit",
            "Uncompressed PCM for music sessions.",
            Some("wav"),
            false,
            true,
        ),
        preset(
            ExportPresetId::Wav48000S24,
            "WAV 48 kHz / 24-bit",
            "Uncompressed PCM for video and modern sessions.",
            Some("wav"),
            false,
            true,
        ),
        preset(
            ExportPresetId::Flac,
            "FLAC",
            "Lossless compressed audio with rich tags.",
            Some("flac"),
            false,
            true,
        ),
        preset(
            ExportPresetId::Opus192,
            "Opus 192 kbps",
            "High-efficiency Opus audio at 192 kbps.",
            Some("opus"),
            true,
            true,
        ),
    ]
}

fn preset(
    id: ExportPresetId,
    label: &str,
    description: &str,
    extension: Option<&str>,
    lossy: bool,
    supports_embedded_tags: bool,
) -> ExportPreset {
    ExportPreset {
        id,
        label: label.to_string(),
        description: description.to_string(),
        extension: extension.map(str::to_string),
        lossy,
        supports_embedded_tags,
    }
}

pub fn validate_export(spec: &ExportSpec) -> AppResult<()> {
    if let Some(lufs) = spec.normalize_lufs {
        if !lufs.is_finite() || !(-24.0..=-8.0).contains(&lufs) {
            return Err(invalid(
                "Loudness normalization must be between -24 and -8 LUFS",
            ));
        }
        if spec.preset_id == ExportPresetId::Original {
            return Err(invalid(
                "Original-stream export cannot apply loudness normalization",
            ));
        }
    }
    if spec.preset_id == ExportPresetId::Original && spec.channel_mode != ChannelMode::Preserve {
        return Err(invalid(
            "Original-stream export cannot change the channel layout",
        ));
    }
    Ok(())
}

pub fn validate_metadata(metadata: &FinalMetadata) -> AppResult<()> {
    validate_text("title", &metadata.title, 240, false)?;
    if let Some(value) = &metadata.artist {
        validate_text("artist", value, 160, true)?;
    }
    if let Some(value) = metadata.bpm {
        if !value.is_finite() || !(20.0..=400.0).contains(&value) {
            return Err(invalid("BPM must be between 20 and 400"));
        }
    }
    if metadata.alternate_bpms.len() > 8
        || metadata
            .alternate_bpms
            .iter()
            .any(|value| !value.is_finite() || !(20.0..=400.0).contains(value))
    {
        return Err(invalid("Alternate BPM values must be between 20 and 400"));
    }
    if let Some(value) = &metadata.key {
        validate_text("key", value, 40, true)?;
    }
    if let Some(value) = &metadata.camelot {
        validate_text("Camelot value", value, 8, true)?;
    }
    if let Some(value) = metadata.detune_cents {
        if !value.is_finite() || !(-1_200.0..=1_200.0).contains(&value) {
            return Err(invalid("Detune must be between -1200 and +1200 cents"));
        }
    }
    if let Some(value) = metadata.tuning_hz {
        if !value.is_finite() || !(300.0..=500.0).contains(&value) {
            return Err(invalid("Tuning frequency must be between 300 and 500 Hz"));
        }
    }
    if metadata.evidence.len() > 64 || metadata.warnings.len() > 32 {
        return Err(invalid("The metadata evidence payload is too large"));
    }
    for evidence in &metadata.evidence {
        validate_text("metadata evidence kind", &evidence.kind, 32, false)?;
        validate_text(
            "metadata evidence value",
            &evidence.display_value,
            120,
            false,
        )?;
        validate_text("metadata evidence text", &evidence.raw_text, 500, true)?;
        validate_text("metadata evidence source", &evidence.source, 32, false)?;
        if !evidence.confidence.is_finite() || !(0.0..=1.0).contains(&evidence.confidence) {
            return Err(invalid(
                "Metadata evidence confidence must be between 0 and 1",
            ));
        }
    }
    for warning in &metadata.warnings {
        validate_text("metadata warning", warning, 500, false)?;
    }
    Ok(())
}

pub fn ffmpeg_transcode_args(
    input: &Path,
    output: &Path,
    spec: &ExportSpec,
    metadata: &FinalMetadata,
) -> AppResult<Vec<String>> {
    validate_export(spec)?;
    validate_metadata(metadata)?;
    if spec.preset_id == ExportPresetId::Original {
        return Err(invalid("Original-stream export does not invoke FFmpeg"));
    }
    let mut args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
        "-map".to_string(),
        "0:a:0".to_string(),
        "-vn".to_string(),
        "-map_metadata".to_string(),
        "-1".to_string(),
    ];
    match spec.preset_id {
        ExportPresetId::Mp3V0 => args.extend(strings(&["-c:a", "libmp3lame", "-q:a", "0"])),
        ExportPresetId::Mp3Cbr320 => args.extend(strings(&["-c:a", "libmp3lame", "-b:a", "320k"])),
        ExportPresetId::M4aAac256 => args.extend(strings(&[
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
        ])),
        ExportPresetId::Wav44100S24 => args.extend(strings(&["-c:a", "pcm_s24le", "-ar", "44100"])),
        ExportPresetId::Wav48000S24 => args.extend(strings(&["-c:a", "pcm_s24le", "-ar", "48000"])),
        ExportPresetId::Flac => args.extend(strings(&["-c:a", "flac", "-compression_level", "8"])),
        ExportPresetId::Opus192 => {
            args.extend(strings(&["-c:a", "libopus", "-b:a", "192k", "-vbr", "on"]))
        }
        ExportPresetId::Original => unreachable!(),
    }
    match spec.channel_mode {
        ChannelMode::Preserve => {}
        ChannelMode::Stereo => args.extend(strings(&["-ac", "2"])),
        ChannelMode::Mono => args.extend(strings(&["-ac", "1"])),
    }
    if let Some(lufs) = spec.normalize_lufs {
        args.extend(strings(&[
            "-af",
            &format!("loudnorm=I={lufs:.1}:LRA=11:TP=-1.0"),
        ]));
    }
    if spec.write_embedded_tags {
        add_metadata_args(&mut args, metadata, spec.preset_id);
    }
    args.extend(strings(&["-progress", "pipe:1", "-nostats"]));
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}

fn add_metadata_args(args: &mut Vec<String>, metadata: &FinalMetadata, preset: ExportPresetId) {
    add_tag(args, "title", &metadata.title);
    if let Some(artist) = metadata.artist.as_deref() {
        add_tag(args, "artist", artist);
    }
    if let Some(bpm) = metadata.bpm {
        let bpm = number(bpm);
        add_tag(args, "BPM", &bpm);
        add_tag(args, "TBPM", &bpm);
        add_tag(args, "tempo", &bpm);
    }
    if let Some(key) = metadata.key.as_deref() {
        add_tag(args, "INITIALKEY", key);
        add_tag(args, "TKEY", key);
        add_tag(args, "key", key);
    }
    if let Some(camelot) = metadata.camelot.as_deref() {
        add_tag(args, "SONIC_CAMELOT", camelot);
    }
    if let Some(detune) = metadata.detune_cents {
        add_tag(args, "SONIC_DETUNE_CENTS", &number(detune));
    }
    if let Some(tuning) = metadata.tuning_hz {
        add_tag(args, "SONIC_TUNING_HZ", &number(tuning));
    }
    if matches!(preset, ExportPresetId::Mp3V0 | ExportPresetId::Mp3Cbr320) {
        args.extend(strings(&["-id3v2_version", "3"]));
    }
}

fn add_tag(args: &mut Vec<String>, key: &str, value: &str) {
    args.push("-metadata".to_string());
    args.push(format!("{key}={value}"));
}

fn validate_text(label: &str, value: &str, max: usize, allow_empty: bool) -> AppResult<()> {
    let length = value.chars().count();
    if (!allow_empty && value.trim().is_empty())
        || length > max
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("The {label} value is invalid or too long")));
    }
    Ok(())
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn number(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> FinalMetadata {
        FinalMetadata {
            title: "Night Shift".into(),
            artist: Some("Producer".into()),
            bpm: Some(144.0),
            key: Some("F# minor".into()),
            camelot: Some("11A".into()),
            detune_cents: Some(-31.8),
            tuning_hz: Some(432.0),
            ..Default::default()
        }
    }

    #[test]
    fn registry_contains_all_fixed_presets() {
        assert_eq!(export_presets().len(), 8);
        assert!(export_presets()
            .iter()
            .any(|preset| preset.id == ExportPresetId::Opus192));
    }

    #[test]
    fn fixed_presets_emit_expected_codec_controls() {
        let input = Path::new("C:/staging/source.webm");
        let output = Path::new("C:/staging/output.mp3");
        let args = ffmpeg_transcode_args(
            input,
            output,
            &ExportSpec {
                preset_id: ExportPresetId::Mp3Cbr320,
                ..Default::default()
            },
            &metadata(),
        )
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["-b:a", "320k"]));
        assert!(args.iter().any(|arg| arg == "TBPM=144"));
        assert!(args.iter().any(|arg| arg == "TKEY=F# minor"));
        assert!(!args.iter().any(|arg| arg.contains(";")));
    }

    #[test]
    fn rejects_processing_for_original() {
        assert!(validate_export(&ExportSpec {
            preset_id: ExportPresetId::Original,
            channel_mode: ChannelMode::Mono,
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn bounds_musical_values() {
        let mut invalid = metadata();
        invalid.bpm = Some(f64::NAN);
        assert!(validate_metadata(&invalid).is_err());
        invalid.bpm = Some(401.0);
        assert!(validate_metadata(&invalid).is_err());
    }
}
