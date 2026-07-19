use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::{
    acquisition::probe_audio,
    error::{conflict, invalid, AppError, AppResult},
    filesystem::{canonical_local_audio, canonical_recorded_file},
    jobs::AppState,
    models::{PreparePreviewRequest, PreviewAsset, PreviewSource, WaveformPeak},
    storage::now_ms,
    tools::{configure_std_command, limited_text, media_tool_path, sha256_file},
};

const DEFAULT_PREVIEW_SECONDS: u32 = 30;
const MAX_PREVIEW_SECONDS: u32 = 60;
const WAVEFORM_SAMPLE_RATE: u32 = 8_000;
const WAVEFORM_BINS: usize = 180;
const PREVIEW_EXPIRY_MS: i64 = 6 * 60 * 60 * 1_000;
const PREVIEW_RETENTION_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_PREVIEW_FILES: usize = 128;
const MAX_PREVIEW_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
struct PreviewCacheEntry {
    path: PathBuf,
    size: u64,
    modified_ms: u64,
}

#[tauri::command]
pub async fn prepare_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    request: PreparePreviewRequest,
) -> AppResult<PreviewAsset> {
    let settings = state.repository.get_settings()?.settings;
    let source = match request.source {
        PreviewSource::LocalFile { path } => {
            canonical_local_audio(&path, settings.max_input_bytes)?
        }
        PreviewSource::LibraryItem { item_id } => {
            let item = state.repository.library_item(&item_id)?;
            let path = canonical_recorded_file(Path::new(&item.audio_path))?
                .ok_or_else(|| invalid("The library audio file is missing"))?;
            if sha256_file(&path)? != item.sha256 {
                return Err(conflict(
                    "The library audio changed after Sonic recorded it; preview is blocked",
                ));
            }
            path
        }
    };
    let max_seconds = request
        .max_duration_seconds
        .unwrap_or(DEFAULT_PREVIEW_SECONDS)
        .clamp(5, MAX_PREVIEW_SECONDS);
    let app_for_task = app.clone();
    let source_for_task = source.clone();
    let (id, path, duration_ms, waveform) = tauri::async_runtime::spawn_blocking(move || {
        generate_preview(&app_for_task, &source_for_task, max_seconds)
    })
    .await
    .map_err(|error| AppError::Internal(format!("Preview generation task failed: {error}")))??;
    if let Err(error) = app.asset_protocol_scope().allow_file(&path) {
        let _ = fs::remove_file(&path);
        return Err(AppError::Internal(format!(
            "Could not scope preview asset: {error}"
        )));
    }
    Ok(PreviewAsset {
        id,
        path: path.to_string_lossy().into_owned(),
        mime_type: "audio/mpeg".into(),
        duration_ms,
        waveform,
        expires_at_ms: now_ms() + PREVIEW_EXPIRY_MS,
    })
}

#[tauri::command]
pub fn release_preview(app: AppHandle, preview_id: String) -> AppResult<bool> {
    let id = Uuid::parse_str(&preview_id).map_err(|_| invalid("The preview ID is invalid"))?;
    if id.to_string() != preview_id.to_ascii_lowercase() {
        return Err(invalid("The preview ID is not canonical"));
    }
    let directory = preview_directory(&app)?;
    let path = directory.join(format!("{id}.mp3"));
    app.asset_protocol_scope()
        .forbid_file(&path)
        .map_err(|error| AppError::Internal(format!("Could not release preview scope: {error}")))?;
    let Some(path) = canonical_recorded_file(&path)? else {
        return Ok(false);
    };
    if path.parent() != Some(directory.as_path()) {
        return Err(conflict("The preview asset escaped Sonic's cache"));
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn generate_preview(
    app: &AppHandle,
    source: &Path,
    max_seconds: u32,
) -> AppResult<(String, PathBuf, u64, Vec<WaveformPeak>)> {
    let directory = preview_directory(app)?;
    enforce_preview_cache_limits(&directory, None)?;
    let probe = probe_audio(app, source)?;
    let duration_ms = probe
        .audio
        .duration_ms
        .unwrap_or(u64::from(max_seconds) * 1_000)
        .min(u64::from(max_seconds) * 1_000);
    let id = Uuid::new_v4().to_string();
    let output = directory.join(format!("{id}.mp3"));
    let executable = media_tool_path(app, "ffmpeg")?;
    let mut command = std::process::Command::new(&executable);
    command.args(["-nostdin", "-hide_banner", "-v", "error", "-i"]);
    command.arg(source);
    command.args([
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        &max_seconds.to_string(),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "160k",
        "-map_metadata",
        "-1",
        "-y",
    ]);
    command.arg(&output);
    configure_std_command(&mut command, executable.parent());
    let result = command
        .output()
        .map_err(|error| AppError::Process(format!("Could not start preview encoder: {error}")))?;
    if !result.status.success() {
        let _ = fs::remove_file(&output);
        return Err(AppError::Process(format!(
            "Could not create preview audio: {}",
            limited_text(&String::from_utf8_lossy(&result.stderr))
        )));
    }
    let canonical = output.canonicalize()?;
    if canonical.parent() != Some(directory.as_path()) || !canonical.is_file() {
        let _ = fs::remove_file(&output);
        return Err(conflict("The generated preview escaped Sonic's cache"));
    }
    let waveform = match render_waveform(app, source, max_seconds) {
        Ok(waveform) => waveform,
        Err(error) => {
            let _ = fs::remove_file(&canonical);
            return Err(error);
        }
    };
    if let Err(error) = enforce_preview_cache_limits(&directory, Some(&canonical)) {
        let _ = fs::remove_file(&canonical);
        return Err(error);
    }
    Ok((id, canonical, duration_ms, waveform))
}

fn render_waveform(
    app: &AppHandle,
    source: &Path,
    max_seconds: u32,
) -> AppResult<Vec<WaveformPeak>> {
    let executable = media_tool_path(app, "ffmpeg")?;
    let mut command = std::process::Command::new(&executable);
    command.args(["-nostdin", "-hide_banner", "-v", "error", "-i"]);
    command.arg(source);
    command.args([
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        &max_seconds.to_string(),
        "-ac",
        "1",
        "-ar",
        &WAVEFORM_SAMPLE_RATE.to_string(),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    configure_std_command(&mut command, executable.parent());
    let output = command.output().map_err(|error| {
        AppError::Process(format!("Could not analyze preview waveform: {error}"))
    })?;
    if !output.status.success() || output.stdout.len() > 2 * 1024 * 1024 {
        return Err(AppError::Process(
            "Could not analyze a bounded preview waveform".into(),
        ));
    }
    Ok(waveform_peaks(&output.stdout, WAVEFORM_BINS))
}

fn waveform_peaks(pcm: &[u8], bin_count: usize) -> Vec<WaveformPeak> {
    let samples = pcm
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    if samples.is_empty() || bin_count == 0 {
        return Vec::new();
    }
    let chunk = samples.len().div_ceil(bin_count).max(1);
    samples
        .chunks(chunk)
        .take(bin_count)
        .map(|samples| {
            let min = samples.iter().copied().min().unwrap_or(0) as f32 / i16::MAX as f32;
            let max = samples.iter().copied().max().unwrap_or(0) as f32 / i16::MAX as f32;
            WaveformPeak {
                min: min.clamp(-1.0, 1.0),
                max: max.clamp(-1.0, 1.0),
            }
        })
        .collect()
}

fn preview_directory(app: &AppHandle) -> AppResult<PathBuf> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| AppError::Internal(format!("Could not resolve preview cache: {error}")))?
        .join("previews");
    fs::create_dir_all(&directory)?;
    Ok(directory.canonicalize()?)
}

fn enforce_preview_cache_limits(directory: &Path, protected: Option<&Path>) -> AppResult<()> {
    let entries = safe_preview_cache_entries(directory)?;
    let cutoff_ms = system_time_ms(SystemTime::now()).saturating_sub(PREVIEW_RETENTION_MS);
    for path in select_preview_evictions(
        &entries,
        protected,
        cutoff_ms,
        MAX_PREVIEW_FILES,
        MAX_PREVIEW_BYTES,
    ) {
        fs::remove_file(path)?;
    }
    let remaining = safe_preview_cache_entries(directory)?;
    let total_bytes = remaining
        .iter()
        .fold(0_u64, |total, entry| total.saturating_add(entry.size));
    if remaining.len() > MAX_PREVIEW_FILES || total_bytes > MAX_PREVIEW_BYTES {
        return Err(AppError::Internal(
            "The bounded preview cache could not be reduced safely".into(),
        ));
    }
    Ok(())
}

fn safe_preview_cache_entries(directory: &Path) -> AppResult<Vec<PreviewCacheEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if !is_canonical_preview_name(&path) {
            continue;
        }
        let Some(canonical) = canonical_recorded_file(&path)? else {
            continue;
        };
        if canonical.parent() != Some(directory) {
            continue;
        }
        let metadata = fs::metadata(&canonical)?;
        entries.push(PreviewCacheEntry {
            path: canonical,
            size: metadata.len(),
            modified_ms: metadata.modified().map(system_time_ms).unwrap_or_default(),
        });
    }
    Ok(entries)
}

fn is_canonical_preview_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_suffix(".mp3"))
        .and_then(|value| Uuid::parse_str(value).ok())
        .is_some_and(|id| {
            path.file_name().and_then(|value| value.to_str()) == Some(&format!("{id}.mp3"))
        })
}

fn select_preview_evictions(
    entries: &[PreviewCacheEntry],
    protected: Option<&Path>,
    cutoff_ms: u64,
    max_files: usize,
    max_bytes: u64,
) -> Vec<PathBuf> {
    let mut order = (0..entries.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        entries[*left]
            .modified_ms
            .cmp(&entries[*right].modified_ms)
            .then_with(|| entries[*left].path.cmp(&entries[*right].path))
    });
    let mut selected = vec![false; entries.len()];
    let mut files = entries.len();
    let mut bytes = entries
        .iter()
        .fold(0_u64, |total, entry| total.saturating_add(entry.size));
    for index in &order {
        let entry = &entries[*index];
        if entry.modified_ms < cutoff_ms && protected != Some(entry.path.as_path()) {
            selected[*index] = true;
            files = files.saturating_sub(1);
            bytes = bytes.saturating_sub(entry.size);
        }
    }
    for index in &order {
        if files <= max_files && bytes <= max_bytes {
            break;
        }
        let entry = &entries[*index];
        if !selected[*index] && protected != Some(entry.path.as_path()) {
            selected[*index] = true;
            files = files.saturating_sub(1);
            bytes = bytes.saturating_sub(entry.size);
        }
    }
    order
        .into_iter()
        .filter(|index| selected[*index])
        .map(|index| entries[index].path.clone())
        .collect()
}

fn system_time_ms(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_is_bounded_and_preserves_extrema() {
        let samples = [-32768_i16, -1000, 0, 1000, 32767];
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        let peaks = waveform_peaks(&bytes, 2);
        assert_eq!(peaks.len(), 2);
        assert_eq!(peaks[0].min, -1.0);
        assert!(peaks[1].max > 0.99);
    }

    #[test]
    fn empty_waveform_is_empty() {
        assert!(waveform_peaks(&[], 180).is_empty());
    }

    #[test]
    fn preview_eviction_removes_stale_then_oldest_to_fit_both_caps() {
        let entries = [
            cache_entry("00000000-0000-0000-0000-000000000001", 10, 1),
            cache_entry("00000000-0000-0000-0000-000000000002", 20, 100),
            cache_entry("00000000-0000-0000-0000-000000000003", 30, 200),
        ];
        let selected = select_preview_evictions(&entries, None, 50, 2, 35);
        assert_eq!(
            selected,
            vec![entries[0].path.clone(), entries[1].path.clone()]
        );
    }

    #[test]
    fn preview_eviction_never_selects_the_protected_asset() {
        let entries = [
            cache_entry("00000000-0000-0000-0000-000000000001", 300, 1),
            cache_entry("00000000-0000-0000-0000-000000000002", 10, 2),
        ];
        let selected = select_preview_evictions(&entries, Some(&entries[0].path), 50, 1, 100);
        assert_eq!(selected, vec![entries[1].path.clone()]);
    }

    fn cache_entry(id: &str, size: u64, modified_ms: u64) -> PreviewCacheEntry {
        PreviewCacheEntry {
            path: PathBuf::from(format!("{id}.mp3")),
            size,
            modified_ms,
        }
    }
}
