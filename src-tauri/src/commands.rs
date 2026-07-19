use std::{fs, io::Write, path::Path, path::PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::{
    acquisition,
    error::{conflict, invalid, AppError, AppResult},
    filesystem::{
        canonical_output_directory, canonical_recorded_file, external_path_string, render_filename,
        safe_cleanup_workspace, sanitize_file_stem,
    },
    jobs::{emit_queue_snapshot, validate_enqueue_item, AppState},
    models::{
        BootstrapSnapshot, DependencyStatus, DiagnosticsQueue, DiagnosticsSnapshot, DownloadFormat,
        DownloadRequest, DownloadStarted, EnqueueExportsRequest, EnqueueItem,
        ExportDiagnosticsRequest, ExportPreset, ExportPresetId, ExportSpec, ExportedDiagnostics,
        FilenamePreview, FilenamePreviewRequest, FinalMetadata, InspectSourceRequest, JobDetail,
        JobPage, JobQuery, LibraryItem, LibraryPage, LibraryQuery, QueueJob, QueueSnapshot,
        ReexportLibraryItemRequest, RemoveLibraryItemRequest, ReorderQueueRequest,
        SetQueuePausedRequest, SettingsSnapshot, SourceInspection, SourceSpec,
        UpdateQueuedJobRequest, UpdateSettingsRequest, VideoInfo,
    },
    presets::{export_presets, validate_metadata},
    sidecar::read_sidecar,
    storage::{now_ms, DB_SCHEMA_VERSION},
    tools,
};

#[tauri::command]
pub async fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> AppResult<BootstrapSnapshot> {
    Ok(BootstrapSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        db_schema_version: DB_SCHEMA_VERSION,
        settings: state.repository.get_settings()?,
        queue: state.repository.queue_snapshot()?,
        dependency_status: tools::dependency_status(&app).await,
        recovery_report: state.recovery_report(),
        recent_library: state.repository.recent_library(12)?,
        export_presets: export_presets(),
    })
}

#[tauri::command]
pub async fn inspect_source(
    app: AppHandle,
    state: State<'_, AppState>,
    request: InspectSourceRequest,
) -> AppResult<SourceInspection> {
    let settings = state.repository.get_settings()?.settings;
    acquisition::inspect_source(&app, request.source, &settings).await
}

#[tauri::command]
pub fn list_export_presets() -> Vec<ExportPreset> {
    export_presets()
}

#[tauri::command]
pub fn preview_filename(request: FilenamePreviewRequest) -> AppResult<FilenamePreview> {
    validate_metadata(&request.metadata)?;
    render_filename(
        &request.template,
        &request.metadata,
        request.preset_id,
        request.original_extension.as_deref(),
        request.source.as_ref(),
    )
}

#[tauri::command]
pub async fn enqueue_exports(
    app: AppHandle,
    state: State<'_, AppState>,
    request: EnqueueExportsRequest,
) -> AppResult<Vec<QueueJob>> {
    if request.items.is_empty() || request.items.len() > 50 {
        return Err(invalid("Queue between 1 and 50 exports at a time"));
    }
    let settings = state.repository.get_settings()?.settings;
    let mut trusted = Vec::with_capacity(request.items.len());
    for mut item in request.items {
        let fresh = acquisition::inspect_source(&app, item.source.clone(), &settings).await?;
        if item
            .expected_fingerprint
            .as_deref()
            .is_some_and(|expected| expected != fresh.source_fingerprint)
        {
            return Err(invalid(
                "A source changed after inspection; inspect the queue again",
            ));
        }
        item.source = fresh.source.clone();
        item.expected_fingerprint = Some(fresh.source_fingerprint.clone());
        item.inspection = fresh;
        validate_enqueue_item(&item)?;
        trusted.push(item);
    }
    let jobs = state.repository.insert_jobs(&trusted)?;
    emit_queue_snapshot(&app, &state.repository);
    state.dispatch(app);
    Ok(jobs)
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>, query: Option<JobQuery>) -> AppResult<JobPage> {
    state.repository.list_jobs(&query.unwrap_or_default())
}

#[tauri::command]
pub fn get_job(state: State<'_, AppState>, job_id: String) -> AppResult<JobDetail> {
    state.repository.job_detail(&job_id)
}

#[tauri::command]
pub fn update_queued_job(
    state: State<'_, AppState>,
    request: UpdateQueuedJobRequest,
) -> AppResult<QueueJob> {
    let mut stored = state.repository.job_detail(&request.job_id)?.request;
    stored.metadata = request.metadata;
    stored.export = request.export;
    stored.output_directory = request.output_directory;
    stored.filename_template = request.filename_template;
    validate_enqueue_item(&stored)?;
    state
        .repository
        .update_queued_job(&request.job_id, &stored, request.expected_revision)
}

#[tauri::command]
pub fn cancel_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> AppResult<QueueJob> {
    let job = state.cancel(&job_id)?;
    emit_queue_snapshot(&app, &state.repository);
    Ok(job)
}

#[tauri::command]
pub fn retry_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> AppResult<QueueJob> {
    let job = state
        .repository
        .retry_job_with_cleanup(&job_id, cleanup_recorded_workspace)?;
    emit_queue_snapshot(&app, &state.repository);
    state.dispatch(app);
    Ok(job)
}

#[tauri::command]
pub fn remove_job(state: State<'_, AppState>, job_id: String) -> AppResult<bool> {
    state
        .repository
        .remove_job_with_cleanup(&job_id, cleanup_recorded_workspace)
}

#[tauri::command]
pub fn reorder_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReorderQueueRequest,
) -> AppResult<QueueSnapshot> {
    let snapshot = state
        .repository
        .reorder_queue(&request.ordered_job_ids, request.expected_revision)?;
    emit_queue_snapshot(&app, &state.repository);
    Ok(snapshot)
}

#[tauri::command]
pub fn set_queue_paused(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SetQueuePausedRequest,
) -> AppResult<QueueSnapshot> {
    let snapshot = state
        .repository
        .set_queue_paused(request.paused, request.expected_revision)?;
    emit_queue_snapshot(&app, &state.repository);
    if !request.paused {
        state.dispatch(app);
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn list_library(
    state: State<'_, AppState>,
    query: Option<LibraryQuery>,
) -> AppResult<LibraryPage> {
    state.repository.list_library(&query.unwrap_or_default())
}

#[tauri::command]
pub fn get_library_item(state: State<'_, AppState>, item_id: String) -> AppResult<LibraryItem> {
    state.repository.library_item(&item_id)
}

#[tauri::command]
pub async fn reexport_library_item(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReexportLibraryItemRequest,
) -> AppResult<QueueJob> {
    let item = state.repository.library_item(&request.item_id)?;
    if item.missing {
        return Err(invalid("The library audio file is missing"));
    }
    let settings = state.repository.get_settings()?.settings;
    let inspection = acquisition::inspect_source(
        &app,
        SourceSpec::LocalFile {
            path: item.audio_path.clone(),
        },
        &settings,
    )
    .await?;
    let metadata = FinalMetadata {
        title: item.title,
        artist: item.artist,
        bpm: item.bpm,
        alternate_bpms: item.alternate_bpms,
        key: item.key,
        camelot: item.camelot,
        detune_cents: item.detune_cents,
        tuning_hz: item.tuning_hz,
        evidence: inspection.suggested_metadata.matches.clone(),
        warnings: inspection.suggested_metadata.warnings.clone(),
    };
    let item = EnqueueItem {
        client_item_id: None,
        source: inspection.source.clone(),
        expected_fingerprint: Some(inspection.source_fingerprint.clone()),
        inspection,
        metadata,
        export: request.export,
        output_directory: request.output_directory,
        filename_template: request.filename_template,
    };
    validate_enqueue_item(&item)?;
    let job = state.repository.insert_job(&item)?;
    emit_queue_snapshot(&app, &state.repository);
    state.dispatch(app);
    Ok(job)
}

#[tauri::command]
pub fn remove_library_item(
    state: State<'_, AppState>,
    request: RemoveLibraryItemRequest,
) -> AppResult<bool> {
    let item = state.repository.library_item(&request.item_id)?;
    let audio = canonical_recorded_file(Path::new(&item.audio_path))?;
    let sidecar_path = canonical_recorded_file(Path::new(&item.sidecar_path))?;
    if request.delete_audio || request.delete_sidecar {
        let sidecar = sidecar_path
            .as_deref()
            .ok_or_else(|| conflict("The metadata sidecar is missing; Sonic will not delete files"))
            .and_then(read_sidecar)?;
        if sidecar.library_item_id != item.id
            || sidecar.job_id != item.job_id
            || sidecar.output_sha256 != item.sha256
        {
            return Err(conflict(
                "The recorded sidecar no longer matches this library item",
            ));
        }
        if let Some(audio) = audio.as_deref() {
            if tools::sha256_file(audio)? != item.sha256 {
                return Err(conflict(
                    "The recorded audio changed; Sonic will not delete the replacement",
                ));
            }
        }
    }
    if request.delete_audio {
        if let Some(path) = audio {
            fs::remove_file(path)?;
        }
    }
    if request.delete_sidecar {
        if let Some(path) = sidecar_path {
            fs::remove_file(path)?;
        }
    }
    state.repository.remove_library_item(&item.id)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<SettingsSnapshot> {
    state.repository.get_settings()
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut request: UpdateSettingsRequest,
) -> AppResult<SettingsSnapshot> {
    if let Some(path) = request
        .patch
        .default_output_directory
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request.patch.default_output_directory =
            Some(external_path_string(&canonical_output_directory(path)?)?);
    }
    let settings = state
        .repository
        .update_settings(request.patch, request.expected_revision)?;
    state.dispatch(app);
    Ok(settings)
}

#[tauri::command]
pub async fn get_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<DiagnosticsSnapshot> {
    let writable = test_data_directory_writable(state.repository.data_directory());
    let queue = state.repository.queue_snapshot()?;
    let failed_count = queue
        .jobs
        .iter()
        .filter(|job| {
            matches!(
                job.state,
                crate::models::JobState::Failed | crate::models::JobState::Interrupted
            )
        })
        .count() as u32;
    let dependencies = redact_dependency_errors(tools::dependency_status(&app).await);
    Ok(DiagnosticsSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        db_schema_version: DB_SCHEMA_VERSION,
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        database_healthy: state.repository.health_check(),
        database_file: state
            .repository
            .database_path()
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sonic.sqlite3".into()),
        data_directory_writable: writable,
        media_engine_directory: "media-engine".into(),
        dependencies,
        queue: DiagnosticsQueue {
            paused: queue.paused,
            active_count: queue.active_count,
            queued_count: queue.queued_count,
            failed_count,
        },
        library_count: state.repository.library_count()?,
        recovery_report: state.recovery_report(),
        generated_at_ms: now_ms(),
    })
}

#[tauri::command]
pub async fn export_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExportDiagnosticsRequest,
) -> AppResult<ExportedDiagnostics> {
    let diagnostics = get_diagnostics(app, state).await?;
    let output = canonical_output_directory(&request.output_directory)?;
    let mut path = output.join(format!(
        "Sonic-diagnostics-{}.json",
        diagnostics.generated_at_ms
    ));
    for index in 2..10_000 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&serde_json::to_vec_pretty(&diagnostics)?)?;
                file.sync_all()?;
                let path = path.canonicalize()?;
                return Ok(ExportedDiagnostics {
                    path: external_path_string(&path)?,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                path = output.join(format!(
                    "Sonic-diagnostics-{}-{}.json",
                    diagnostics.generated_at_ms, index
                ));
            }
            Err(error) => return Err(AppError::Io(error)),
        }
    }
    Err(conflict("Could not choose a diagnostics filename"))
}

// Legacy aliases retained for the existing installer smoke test and gradual frontend migration.
#[tauri::command]
pub async fn check_dependencies(app: AppHandle) -> DependencyStatus {
    tools::dependency_status(&app).await
}

#[tauri::command]
pub fn get_default_output_dir(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    get_default_output_dir_typed(&app, &state).map_err(|error| error.public_message())
}

fn get_default_output_dir_typed(app: &AppHandle, state: &AppState) -> AppResult<String> {
    if let Some(path) = state
        .repository
        .get_settings()?
        .settings
        .default_output_directory
    {
        return external_path_string(&canonical_output_directory(&path)?);
    }
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().desktop_dir())
        .map_err(|error| AppError::Internal(format!("Could not locate Downloads: {error}")))?;
    external_path_string(&canonical_output_directory(
        &base.join("Sonic").to_string_lossy(),
    )?)
}

#[tauri::command]
pub async fn prepare_media_engine(app: AppHandle) -> Result<String, String> {
    tools::prepare_media_engine(app)
        .await
        .map_err(|error| error.public_message())
}

#[tauri::command]
pub async fn inspect_video(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<VideoInfo, String> {
    let settings = state
        .repository
        .get_settings()
        .map_err(|error| error.public_message())?
        .settings;
    let inspection = acquisition::inspect_source(&app, SourceSpec::Youtube { url }, &settings)
        .await
        .map_err(|error| error.public_message())?;
    Ok(VideoInfo {
        id: inspection.id,
        title: inspection.title,
        description: inspection.description.unwrap_or_default(),
        thumbnail_url: inspection.thumbnail_url,
        duration_seconds: inspection.audio.duration_ms.map(|value| value / 1_000),
        uploader: inspection.artist,
        webpage_url: inspection.webpage_url.unwrap_or_default(),
        is_live: inspection.is_live,
        metadata: inspection.suggested_metadata,
    })
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DownloadRequest,
) -> Result<DownloadStarted, String> {
    start_download_typed(app, &state, request)
        .await
        .map_err(|error| error.public_message())
}

async fn start_download_typed(
    app: AppHandle,
    state: &AppState,
    request: DownloadRequest,
) -> AppResult<DownloadStarted> {
    let settings = state.repository.get_settings()?.settings;
    let inspection =
        acquisition::inspect_source(&app, SourceSpec::Youtube { url: request.url }, &settings)
            .await?;
    let mut metadata = FinalMetadata::from_inspection(&inspection);
    if let Some(value) = request.bpm {
        metadata.bpm = Some(value);
    }
    if let Some(value) = request.key {
        metadata.key = Some(value);
    }
    if let Some(value) = request.detune_cents {
        metadata.detune_cents = Some(value);
    }
    if let Some(value) = request.file_name {
        let stem = sanitize_file_stem(value.trim_end_matches('.'));
        if !stem.is_empty() {
            metadata.title = stem;
        }
    }
    let preset_id = match request.format {
        DownloadFormat::Original => ExportPresetId::Original,
        DownloadFormat::Wav => ExportPresetId::Wav44100S24,
        DownloadFormat::Mp3 => ExportPresetId::Mp3Cbr320,
        DownloadFormat::M4a => ExportPresetId::M4aAac256,
    };
    let item = EnqueueItem {
        client_item_id: None,
        source: inspection.source.clone(),
        expected_fingerprint: Some(inspection.source_fingerprint.clone()),
        inspection,
        metadata,
        export: ExportSpec {
            preset_id,
            write_embedded_tags: settings.write_embedded_tags,
            ..Default::default()
        },
        output_directory: request.output_directory,
        filename_template: "{title}".into(),
    };
    validate_enqueue_item(&item)?;
    let job = state.repository.insert_job(&item)?;
    emit_queue_snapshot(&app, &state.repository);
    state.dispatch(app);
    Ok(DownloadStarted { job_id: job.id })
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, job_id: String) -> Result<bool, String> {
    let detail = match state.repository.job_detail(&job_id) {
        Ok(detail) => detail,
        Err(_) => return Ok(false),
    };
    if detail.summary.state.is_terminal() {
        return Ok(false);
    }
    state
        .cancel(&job_id)
        .map(|_| true)
        .map_err(|error| error.public_message())
}

fn cleanup_recorded_workspace(detail: &JobDetail) -> AppResult<()> {
    if let Some(workspace) = &detail.working_directory {
        let output = canonical_output_directory(&detail.request.output_directory)?;
        let workspace = PathBuf::from(workspace);
        if workspace.exists() && !safe_cleanup_workspace(&workspace, &output, &detail.summary.id) {
            return Err(conflict(
                "Sonic could not safely clean the previous job workspace",
            ));
        }
    }
    Ok(())
}

fn test_data_directory_writable(directory: &Path) -> bool {
    let path = directory.join(format!(".sonic-write-test-{}", now_ms()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            let written = file.write_all(b"ok").is_ok() && file.sync_all().is_ok();
            drop(file);
            let removed = fs::remove_file(path).is_ok();
            written && removed
        }
        Err(_) => false,
    }
}

fn redact_dependency_errors(mut status: DependencyStatus) -> DependencyStatus {
    for dependency in &mut status.dependencies {
        if dependency.error.is_some() {
            dependency.error =
                Some("Unavailable; inspect Sonic's engine status for details".into());
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DependencyInfo, RecoveryReport};

    #[test]
    fn diagnostics_serialization_redacts_path_sentinels_and_has_only_queue_aggregates() {
        let sentinel = r"C:\Users\secret\producer-beat.wav";
        let dependencies = redact_dependency_errors(DependencyStatus {
            ready: false,
            dependencies: vec![DependencyInfo {
                name: "ffmpeg".into(),
                available: false,
                version: None,
                error: Some(format!("failed while probing {sentinel}")),
            }],
        });
        let snapshot = DiagnosticsSnapshot {
            app_version: "0.2.0".into(),
            db_schema_version: DB_SCHEMA_VERSION,
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
            database_healthy: true,
            database_file: "sonic.sqlite3".into(),
            data_directory_writable: true,
            media_engine_directory: "media-engine".into(),
            dependencies,
            queue: DiagnosticsQueue {
                paused: false,
                active_count: 1,
                queued_count: 2,
                failed_count: 3,
            },
            library_count: 4,
            recovery_report: RecoveryReport::default(),
            generated_at_ms: 5,
        };
        let value = serde_json::to_value(snapshot).unwrap();
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(!serialized.contains(sentinel));
        assert!(value["queue"].get("jobs").is_none());
        assert!(value.get("source").is_none());
        assert!(value.get("title").is_none());
    }
}
