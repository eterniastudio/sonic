use serde::{Deserialize, Serialize};

use crate::metadata::MusicMetadata;

pub const JOB_UPDATED_EVENT: &str = "sonic://job-updated";
pub const QUEUE_UPDATED_EVENT: &str = "sonic://queue-updated";
pub const LEGACY_PROGRESS_EVENT: &str = "sonic://download-progress";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceSpec {
    Youtube { url: String },
    LocalFile { path: String },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioProperties {
    pub container: Option<String>,
    pub codec: Option<String>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
    pub bit_depth: Option<u16>,
    pub duration_ms: Option<u64>,
    pub file_size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInspection {
    pub id: String,
    pub source: SourceSpec,
    pub source_fingerprint: String,
    pub title: String,
    pub artist: Option<String>,
    pub description: Option<String>,
    pub thumbnail_url: Option<String>,
    pub webpage_url: Option<String>,
    pub is_live: bool,
    pub audio: AudioProperties,
    pub declared_metadata: MusicMetadata,
    pub embedded_metadata: MusicMetadata,
    /// Evidence-ranked merge of declared text and embedded tags only.
    /// Sonic v0.2 does not derive these values from the audio signal.
    pub suggested_metadata: MusicMetadata,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectSourceRequest {
    pub source: SourceSpec,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub bpm: Option<f64>,
    #[serde(default)]
    pub alternate_bpms: Vec<f64>,
    pub key: Option<String>,
    pub camelot: Option<String>,
    pub detune_cents: Option<f64>,
    pub tuning_hz: Option<f64>,
    #[serde(default)]
    pub evidence: Vec<crate::metadata::MetadataMatch>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl FinalMetadata {
    pub fn from_inspection(value: &SourceInspection) -> Self {
        let music = &value.suggested_metadata;
        Self {
            title: value.title.clone(),
            artist: value.artist.clone(),
            bpm: music.bpm,
            alternate_bpms: music.alternate_bpms.clone(),
            key: music.key.clone(),
            camelot: music.camelot.clone(),
            detune_cents: music.detune_cents,
            tuning_hz: music.tuning_hz,
            evidence: music.matches.clone(),
            warnings: music.warnings.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ExportPresetId {
    Original,
    Mp3V0,
    #[default]
    Mp3Cbr320,
    M4aAac256,
    Wav44100S24,
    Wav48000S24,
    Flac,
    Opus192,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChannelMode {
    #[default]
    Preserve,
    Stereo,
    Mono,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: ExportPresetId,
    pub label: String,
    pub description: String,
    pub extension: Option<String>,
    pub lossy: bool,
    pub supports_embedded_tags: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    #[serde(default)]
    pub preset_id: ExportPresetId,
    #[serde(default)]
    pub channel_mode: ChannelMode,
    pub normalize_lufs: Option<f64>,
    #[serde(default = "default_true")]
    pub write_embedded_tags: bool,
}

impl Default for ExportSpec {
    fn default() -> Self {
        Self {
            preset_id: ExportPresetId::default(),
            channel_mode: ChannelMode::default(),
            normalize_lufs: None,
            write_embedded_tags: true,
        }
    }
}

const fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueItem {
    pub client_item_id: Option<String>,
    pub source: SourceSpec,
    pub expected_fingerprint: Option<String>,
    pub inspection: SourceInspection,
    pub metadata: FinalMetadata,
    pub export: ExportSpec,
    pub output_directory: String,
    pub filename_template: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueExportsRequest {
    pub items: Vec<EnqueueItem>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Preparing,
    Acquiring,
    Copying,
    Transcoding,
    Tagging,
    Validating,
    Publishing,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Preparing => "preparing",
            Self::Acquiring => "acquiring",
            Self::Copying => "copying",
            Self::Transcoding => "transcoding",
            Self::Tagging => "tagging",
            Self::Validating => "validating",
            Self::Publishing => "publishing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        Some(match value {
            "queued" => Self::Queued,
            "preparing" => Self::Preparing,
            "acquiring" => Self::Acquiring,
            "copying" => Self::Copying,
            "transcoding" => Self::Transcoding,
            "tagging" => Self::Tagging,
            "validating" => Self::Validating,
            "publishing" => Self::Publishing,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            _ => return None,
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub percent: Option<f64>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_second: Option<f64>,
    pub eta_seconds: Option<u64>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueJob {
    pub id: String,
    pub client_item_id: Option<String>,
    pub state: JobState,
    pub queue_position: i64,
    pub revision: i64,
    pub source: SourceSpec,
    pub title: String,
    pub artist: Option<String>,
    pub preset_id: ExportPresetId,
    pub progress: JobProgress,
    pub output_path: Option<String>,
    pub sidecar_path: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub attempt: u32,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    #[serde(flatten)]
    pub summary: QueueJob,
    pub request: EnqueueItem,
    pub working_directory: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPage {
    pub items: Vec<QueueJob>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobQuery {
    #[serde(default)]
    pub states: Vec<JobState>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub paused: bool,
    pub revision: i64,
    pub active_count: u32,
    pub queued_count: u32,
    pub jobs: Vec<QueueJob>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderQueueRequest {
    pub ordered_job_ids: Vec<String>,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetQueuePausedRequest {
    pub paused: bool,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateQueuedJobRequest {
    pub job_id: String,
    pub metadata: FinalMetadata,
    pub export: ExportSpec,
    pub output_directory: String,
    pub filename_template: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_output_directory: Option<String>,
    pub filename_template: String,
    pub default_preset_id: ExportPresetId,
    pub max_concurrent_jobs: u8,
    pub history_enabled: bool,
    pub write_embedded_tags: bool,
    pub include_source_path_in_sidecar: bool,
    pub max_duration_minutes: u32,
    pub max_input_bytes: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_output_directory: None,
            filename_template: "{title} - {bpm} BPM - {key}".to_string(),
            default_preset_id: ExportPresetId::Mp3Cbr320,
            max_concurrent_jobs: 1,
            history_enabled: true,
            write_embedded_tags: true,
            include_source_path_in_sidecar: false,
            max_duration_minutes: 30,
            max_input_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub revision: i64,
    pub settings: AppSettings,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub default_output_directory: Option<String>,
    pub filename_template: Option<String>,
    pub default_preset_id: Option<ExportPresetId>,
    pub max_concurrent_jobs: Option<u8>,
    pub history_enabled: Option<bool>,
    pub write_embedded_tags: Option<bool>,
    pub include_source_path_in_sidecar: Option<bool>,
    pub max_duration_minutes: Option<u32>,
    pub max_input_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub patch: SettingsPatch,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub job_id: String,
    pub client_item_id: Option<String>,
    pub source: SourceSpec,
    pub title: String,
    pub artist: Option<String>,
    pub thumbnail_url: Option<String>,
    pub bpm: Option<f64>,
    pub alternate_bpms: Vec<f64>,
    pub key: Option<String>,
    pub camelot: Option<String>,
    pub detune_cents: Option<f64>,
    pub tuning_hz: Option<f64>,
    pub preset_id: ExportPresetId,
    pub format: String,
    pub codec: Option<String>,
    pub duration_ms: Option<u64>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
    pub audio_path: String,
    pub sidecar_path: String,
    pub file_size_bytes: u64,
    pub sha256: String,
    pub missing: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryQuery {
    pub search: Option<String>,
    pub key: Option<String>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub format: Option<String>,
    pub missing: Option<bool>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPage {
    pub items: Vec<LibraryItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReexportLibraryItemRequest {
    pub item_id: String,
    pub export: ExportSpec,
    pub output_directory: String,
    pub filename_template: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLibraryItemRequest {
    pub item_id: String,
    #[serde(default)]
    pub delete_audio: bool,
    #[serde(default)]
    pub delete_sidecar: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub interrupted_jobs: u32,
    pub recovered_jobs: u32,
    pub cleaned_workspaces: u32,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub app_version: String,
    pub db_schema_version: u32,
    pub settings: SettingsSnapshot,
    pub queue: QueueSnapshot,
    pub dependency_status: DependencyStatus,
    pub recovery_report: RecoveryReport,
    pub recent_library: Vec<LibraryItem>,
    pub export_presets: Vec<ExportPreset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub app_version: String,
    pub db_schema_version: u32,
    pub operating_system: String,
    pub architecture: String,
    pub database_healthy: bool,
    pub database_file: String,
    pub data_directory_writable: bool,
    pub media_engine_directory: String,
    pub dependencies: DependencyStatus,
    pub queue: DiagnosticsQueue,
    pub library_count: u64,
    pub recovery_report: RecoveryReport,
    pub generated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsQueue {
    pub paused: bool,
    pub active_count: u32,
    pub queued_count: u32,
    pub failed_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDiagnosticsRequest {
    pub output_directory: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedDiagnostics {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewSource {
    LocalFile { path: String },
    LibraryItem { item_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparePreviewRequest {
    pub source: PreviewSource,
    pub max_duration_seconds: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeak {
    pub min: f32,
    pub max: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAsset {
    pub id: String,
    pub path: String,
    pub mime_type: String,
    pub duration_ms: u64,
    pub waveform: Vec<WaveformPeak>,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenamePreviewRequest {
    pub template: String,
    pub metadata: FinalMetadata,
    pub preset_id: ExportPresetId,
    pub original_extension: Option<String>,
    pub source: Option<SourceSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenamePreview {
    pub stem: String,
    pub extension: String,
    pub full_name: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub ready: bool,
    pub dependencies: Vec<DependencyInfo>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

// v0.1 command compatibility types. These remain serialized exactly as before.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub thumbnail_url: Option<String>,
    pub duration_seconds: Option<u64>,
    pub uploader: Option<String>,
    pub webpage_url: String,
    pub is_live: bool,
    pub metadata: MusicMetadata,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadFormat {
    Original,
    Wav,
    Mp3,
    M4a,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub output_directory: String,
    pub format: DownloadFormat,
    pub file_name: Option<String>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub detune_cents: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStarted {
    pub job_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub job_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_and_preset_contracts_are_camel_case() {
        assert_eq!(
            serde_json::to_value(SourceSpec::LocalFile {
                path: "C:\\beat.wav".to_string()
            })
            .unwrap(),
            serde_json::json!({"kind":"localFile","path":"C:\\beat.wav"})
        );
        assert_eq!(
            serde_json::to_value(ExportPresetId::Mp3Cbr320).unwrap(),
            serde_json::json!("mp3Cbr320")
        );
        assert_eq!(
            serde_json::to_value(JobState::Transcoding).unwrap(),
            serde_json::json!("transcoding")
        );
    }
}
