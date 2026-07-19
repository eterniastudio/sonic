use std::{collections::HashMap, path::Path};

use serde::Deserialize;
use tauri::AppHandle;
use url::Url;
use uuid::Uuid;

use crate::{
    error::{invalid, AppError, AppResult},
    filesystem::canonical_local_audio,
    metadata::{self, MusicMetadata},
    models::{AppSettings, AudioProperties, SourceInspection, SourceSpec},
    tools::{
        bundled_js_runtime, configure_std_command, limited_text, media_tool_path, sha256_file,
        yt_dlp_command,
    },
};

const MAX_URL_LENGTH: usize = 2_048;
const MAX_DESCRIPTION_CHARACTERS: usize = 100_000;
const MAX_TITLE_CHARACTERS: usize = 240;

#[derive(Deserialize)]
struct YtDlpVideoInfo {
    id: Option<String>,
    title: Option<String>,
    fulltitle: Option<String>,
    description: Option<String>,
    thumbnail: Option<String>,
    duration: Option<f64>,
    filesize: Option<f64>,
    filesize_approx: Option<f64>,
    uploader: Option<String>,
    channel: Option<String>,
    #[serde(default)]
    is_live: bool,
    ext: Option<String>,
    acodec: Option<String>,
    asr: Option<u32>,
    audio_channels: Option<u16>,
}

#[derive(Clone, Debug, Default)]
pub struct ProbeResult {
    pub audio: AudioProperties,
    pub tags: HashMap<String, String>,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u16>,
    bits_per_sample: Option<u16>,
    bits_per_raw_sample: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    size: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
}

pub async fn inspect_source(
    app: &AppHandle,
    source: SourceSpec,
    settings: &AppSettings,
) -> AppResult<SourceInspection> {
    match source {
        SourceSpec::Youtube { url } => inspect_youtube(app, &url, settings).await,
        SourceSpec::LocalFile { path } => {
            let app = app.clone();
            let settings = settings.clone();
            tauri::async_runtime::spawn_blocking(move || inspect_local(&app, &path, &settings))
                .await
                .map_err(|error| AppError::Internal(format!("Local inspection failed: {error}")))?
        }
    }
}

async fn inspect_youtube(
    app: &AppHandle,
    input: &str,
    settings: &AppSettings,
) -> AppResult<SourceInspection> {
    let url = validate_youtube_url(input)?;
    let js_runtime = bundled_js_runtime(app)?;
    let args = vec![
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--no-update".to_string(),
        "--no-plugin-dirs".to_string(),
        "--no-remote-components".to_string(),
        "--js-runtimes".to_string(),
        js_runtime,
        "--socket-timeout".to_string(),
        "20".to_string(),
        "--retries".to_string(),
        "2".to_string(),
        "--skip-download".to_string(),
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
        "--".to_string(),
        url,
    ];
    let output = yt_dlp_command(app)?
        .args(args)
        .output()
        .await
        .map_err(|error| AppError::Process(format!("Could not inspect the video: {error}")))?;
    if !output.status.success() {
        let message = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(AppError::Process(if message.is_empty() {
            "yt-dlp could not inspect this video".into()
        } else {
            message
        }));
    }
    let raw: YtDlpVideoInfo = serde_json::from_slice(&output.stdout)
        .map_err(|error| AppError::Process(format!("yt-dlp returned invalid metadata: {error}")))?;
    let id = raw
        .id
        .filter(|id| valid_youtube_id(id))
        .ok_or_else(|| AppError::Process("The video metadata did not include a valid ID".into()))?;
    let title = bounded_text(
        raw.title.or(raw.fulltitle).as_deref().unwrap_or(""),
        MAX_TITLE_CHARACTERS,
    );
    if title.is_empty() {
        return Err(AppError::Process(
            "The video metadata did not include a title".into(),
        ));
    }
    let description = bounded_text(
        raw.description.as_deref().unwrap_or(""),
        MAX_DESCRIPTION_CHARACTERS,
    );
    let duration_ms =
        finite_nonnegative(raw.duration).map(|value| (value * 1_000.0).round() as u64);
    validate_duration(duration_ms, settings)?;
    let file_size =
        finite_nonnegative(raw.filesize.or(raw.filesize_approx)).map(|value| value.round() as u64);
    if file_size.is_some_and(|value| value > settings.max_input_bytes) {
        return Err(invalid(
            "The selected source exceeds Sonic's configured size limit",
        ));
    }
    let metadata = metadata::parse_music_metadata(&title, &description);
    let canonical_url = format!("https://www.youtube.com/watch?v={id}");
    let audio = AudioProperties {
        container: raw.ext,
        codec: raw.acodec,
        sample_rate_hz: raw.asr,
        channels: raw.audio_channels,
        bit_depth: None,
        duration_ms,
        file_size_bytes: file_size,
    };
    Ok(SourceInspection {
        id: id.clone(),
        source: SourceSpec::Youtube {
            url: canonical_url.clone(),
        },
        source_fingerprint: format!("youtube:{id}"),
        title,
        artist: raw
            .uploader
            .or(raw.channel)
            .map(|value| bounded_text(&value, 160)),
        description: (!description.is_empty()).then_some(description),
        thumbnail_url: raw.thumbnail.and_then(validate_thumbnail_url),
        webpage_url: Some(canonical_url),
        is_live: raw.is_live,
        audio,
        declared_metadata: metadata.clone(),
        embedded_metadata: MusicMetadata::default(),
        suggested_metadata: metadata,
        warnings: Vec::new(),
    })
}

pub fn inspect_local(
    app: &AppHandle,
    input: &str,
    settings: &AppSettings,
) -> AppResult<SourceInspection> {
    let path = canonical_local_audio(input, settings.max_input_bytes)?;
    let fingerprint = sha256_file(&path)?;
    let probe = probe_audio(app, &path)?;
    validate_duration(probe.audio.duration_ms, settings)?;
    let filename = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled local audio")
        .to_string();
    let title = tag_value(&probe.tags, &["title"])
        .map(|value| bounded_text(value, MAX_TITLE_CHARACTERS))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| bounded_text(&filename, MAX_TITLE_CHARACTERS));
    let artist = tag_value(&probe.tags, &["artist", "album_artist", "author"])
        .map(|value| bounded_text(value, 160))
        .filter(|value| !value.is_empty());
    let tag_text = probe
        .tags
        .iter()
        .take(64)
        .map(|(key, value)| format!("{key}: {}", bounded_text(value, 500)))
        .collect::<Vec<_>>()
        .join("\n");
    let declared_metadata = metadata::parse_music_metadata(&filename, "");
    let embedded_metadata = metadata::parse_music_metadata(&title, &tag_text);
    let suggested_metadata = merge_metadata(&embedded_metadata, &declared_metadata);
    let source_path = path.to_string_lossy().into_owned();
    Ok(SourceInspection {
        id: Uuid::new_v4().to_string(),
        source: SourceSpec::LocalFile {
            path: source_path.clone(),
        },
        source_fingerprint: format!("sha256:{fingerprint}"),
        title,
        artist,
        description: tag_value(&probe.tags, &["description", "comment"])
            .map(|value| bounded_text(value, 2_000))
            .filter(|value| !value.is_empty()),
        thumbnail_url: None,
        webpage_url: None,
        is_live: false,
        audio: probe.audio,
        declared_metadata,
        embedded_metadata,
        suggested_metadata,
        warnings: Vec::new(),
    })
}

pub fn probe_audio(app: &AppHandle, path: &Path) -> AppResult<ProbeResult> {
    let executable = media_tool_path(app, "ffprobe")?;
    let mut command = std::process::Command::new(&executable);
    command.args([
        "-v",
        "error",
        "-show_entries",
        "format=format_name,duration,size:format_tags:stream=codec_type,codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,duration:stream_tags",
        "-of",
        "json",
        "--",
    ]);
    command.arg(path);
    configure_std_command(&mut command, executable.parent());
    let output = command
        .output()
        .map_err(|error| AppError::Engine(format!("Could not start ffprobe: {error}")))?;
    if !output.status.success() {
        let message = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(invalid(if message.is_empty() {
            "ffprobe could not read this local audio file".into()
        } else {
            format!("ffprobe could not read this file: {message}")
        }));
    }
    parse_probe_output(&output.stdout)
}

fn parse_probe_output(bytes: &[u8]) -> AppResult<ProbeResult> {
    let raw: FfprobeOutput = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("ffprobe returned invalid media metadata: {error}")))?;
    let stream = raw
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"))
        .ok_or_else(|| invalid("The selected file contains no readable audio stream"))?;
    let format = raw.format;
    let mut tags = format
        .as_ref()
        .map(|value| value.tags.clone())
        .unwrap_or_default();
    for (key, value) in &stream.tags {
        tags.entry(key.clone()).or_insert_with(|| value.clone());
    }
    let duration = stream
        .duration
        .as_deref()
        .and_then(parse_nonnegative)
        .or_else(|| {
            format
                .as_ref()?
                .duration
                .as_deref()
                .and_then(parse_nonnegative)
        });
    let bit_depth = stream
        .bits_per_raw_sample
        .as_deref()
        .and_then(|value| value.parse::<u16>().ok())
        .or(stream.bits_per_sample)
        .filter(|value| *value > 0);
    Ok(ProbeResult {
        audio: AudioProperties {
            container: format.as_ref().and_then(|value| value.format_name.clone()),
            codec: stream.codec_name.clone(),
            sample_rate_hz: stream
                .sample_rate
                .as_deref()
                .and_then(|value| value.parse::<u32>().ok()),
            channels: stream.channels,
            bit_depth,
            duration_ms: duration.map(|value| (value * 1_000.0).round() as u64),
            file_size_bytes: format
                .as_ref()
                .and_then(|value| value.size.as_deref())
                .and_then(|value| value.parse::<u64>().ok()),
        },
        tags,
    })
}

pub fn validate_youtube_url(input: &str) -> AppResult<String> {
    let input = input.trim();
    if input.is_empty() || input.len() > MAX_URL_LENGTH {
        return Err(invalid("Enter a valid YouTube video URL"));
    }
    let parsed = Url::parse(input).map_err(|_| invalid("Enter a valid YouTube video URL"))?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid("Only secure YouTube video URLs are supported"));
    }
    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid("Enter a valid YouTube video URL"))?;
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let valid = match host.as_str() {
        "youtu.be" | "www.youtu.be" => segments.first().is_some_and(|id| valid_youtube_id(id)),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            match segments.first().copied() {
                Some("watch") => parsed
                    .query_pairs()
                    .any(|(key, value)| key == "v" && valid_youtube_id(&value)),
                Some("shorts" | "live" | "embed") => {
                    segments.get(1).is_some_and(|id| valid_youtube_id(id))
                }
                _ => false,
            }
        }
        "youtube-nocookie.com" | "www.youtube-nocookie.com" => {
            segments.first() == Some(&"embed")
                && segments.get(1).is_some_and(|id| valid_youtube_id(id))
        }
        _ => false,
    };
    if !valid {
        return Err(invalid(
            "Enter a direct YouTube video, Short, or live-video URL",
        ));
    }
    Ok(parsed.to_string())
}

fn valid_youtube_id(value: &str) -> bool {
    let length = value.len();
    (6..=64).contains(&length)
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_duration(duration_ms: Option<u64>, settings: &AppSettings) -> AppResult<()> {
    if duration_ms.is_some_and(|value| value > u64::from(settings.max_duration_minutes) * 60_000) {
        return Err(invalid(format!(
            "The source exceeds the configured {} minute duration limit",
            settings.max_duration_minutes
        )));
    }
    Ok(())
}

fn merge_metadata(primary: &MusicMetadata, fallback: &MusicMetadata) -> MusicMetadata {
    let mut merged = primary.clone();
    if merged.bpm.is_none() {
        merged.bpm = fallback.bpm;
        merged.alternate_bpms = fallback.alternate_bpms.clone();
    }
    if merged.key.is_none() {
        merged.key = fallback.key.clone();
        merged.camelot = fallback.camelot.clone();
    }
    if merged.detune_cents.is_none() {
        merged.detune_cents = fallback.detune_cents;
        merged.tuning_hz = fallback.tuning_hz;
    }
    merged.matches.extend(fallback.matches.clone());
    merged.warnings.extend(fallback.warnings.clone());
    merged.confidence = merged.confidence.max(fallback.confidence);
    merged
}

fn tag_value<'a>(tags: &'a HashMap<String, String>, names: &[&str]) -> Option<&'a str> {
    tags.iter().find_map(|(key, value)| {
        names
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
            .then_some(value.as_str())
    })
}

fn validate_thumbnail_url(value: String) -> Option<String> {
    let parsed = Url::parse(&value).ok()?;
    (parsed.scheme() == "https"
        && parsed.host_str().is_some_and(|host| {
            ["ytimg.com", "ggpht.com"]
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        }))
    .then_some(value)
}

fn bounded_text(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

fn parse_nonnegative(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn finite_nonnegative(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_direct_youtube_urls() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtu.be/dQw4w9WgXcQ?t=1").is_ok());
        assert!(validate_youtube_url("https://youtube.com/shorts/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtube.com/playlist?list=abc").is_err());
        assert!(validate_youtube_url("https://example.com/watch?v=dQw4w9WgXcQ").is_err());
        assert!(validate_youtube_url("http://youtube.com/watch?v=dQw4w9WgXcQ").is_err());
    }

    #[test]
    fn parses_ffprobe_audio_and_tags() {
        let bytes = br#"{
          "streams":[{"codec_type":"audio","codec_name":"flac","sample_rate":"48000","channels":2,"bits_per_raw_sample":"24","duration":"12.5","tags":{"BPM":"144"}}],
          "format":{"format_name":"flac","duration":"12.5","size":"1000","tags":{"title":"Beat"}}
        }"#;
        let probe = parse_probe_output(bytes).unwrap();
        assert_eq!(probe.audio.codec.as_deref(), Some("flac"));
        assert_eq!(probe.audio.sample_rate_hz, Some(48_000));
        assert_eq!(probe.audio.bit_depth, Some(24));
        assert_eq!(probe.audio.duration_ms, Some(12_500));
        assert_eq!(tag_value(&probe.tags, &["bpm"]), Some("144"));
    }

    #[test]
    fn rejects_probe_without_audio() {
        assert!(parse_probe_output(br#"{"streams":[],"format":{}}"#).is_err());
    }
}
