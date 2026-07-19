use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{Command as ShellCommand, CommandChild, CommandEvent};
use uuid::Uuid;

use crate::{
    acquisition::{probe_audio, validate_youtube_url},
    error::{invalid, AppError, AppResult},
    filesystem::{
        canonical_local_audio, canonical_output_directory, canonical_recorded_file,
        prepare_workspace, preset_extension, publish_pair, read_publication_journal,
        render_filename, safe_cleanup_workspace,
    },
    models::{
        AppSettings, DownloadProgress, EnqueueItem, ExportPresetId, JobProgress, JobState,
        LibraryItem, QueueJob, RecoveryReport, SettingsPatch, SourceSpec, JOB_UPDATED_EVENT,
        LEGACY_PROGRESS_EVENT, QUEUE_UPDATED_EVENT,
    },
    presets::{ffmpeg_transcode_args, validate_export, validate_metadata},
    sidecar::{build_sidecar, read_sidecar, write_sidecar, SidecarBuild, SonicSidecar, TagStatus},
    storage::{now_ms, Repository},
    tools::{
        bundled_js_runtime, ffmpeg_directory, limited_text, media_command, sha256_file,
        yt_dlp_command,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub repository: Repository,
    manager: JobManager,
    recovery_report: Arc<Mutex<RecoveryReport>>,
}

impl AppState {
    pub fn initialize(app: &AppHandle) -> AppResult<Self> {
        let repository = Repository::open(app)?;
        let settings = repository.get_settings()?;
        if settings.settings.default_output_directory.is_none() {
            if let Ok(base) = app
                .path()
                .download_dir()
                .or_else(|_| app.path().desktop_dir())
            {
                if let Ok(output) =
                    canonical_output_directory(&base.join("Sonic").to_string_lossy())
                {
                    let _ = repository.update_settings(
                        SettingsPatch {
                            default_output_directory: Some(output.to_string_lossy().into_owned()),
                            ..Default::default()
                        },
                        settings.revision,
                    );
                }
            }
        }
        let recovery_report = recover_interrupted_jobs(&repository)?;
        Ok(Self {
            repository,
            manager: JobManager::default(),
            recovery_report: Arc::new(Mutex::new(recovery_report)),
        })
    }

    pub fn recovery_report(&self) -> RecoveryReport {
        self.recovery_report
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn dispatch(&self, app: AppHandle) {
        if !self.manager.request_dispatch() {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            state.dispatch_loop(app).await;
        });
    }

    async fn dispatch_loop(&self, app: AppHandle) {
        loop {
            self.manager.begin_dispatch_pass();
            loop {
                let max = self
                    .repository
                    .get_settings()
                    .map(|settings| settings.settings.max_concurrent_jobs as usize)
                    .unwrap_or(1)
                    .clamp(1, 3);
                if self.manager.active_count() >= max {
                    break;
                }
                let detail = match self.repository.claim_next_job() {
                    Ok(Some(detail)) => detail,
                    Ok(None) => break,
                    Err(_) => break,
                };
                let active = Arc::new(ActiveJob::default());
                if self
                    .manager
                    .insert(detail.summary.id.clone(), active.clone())
                    .is_err()
                {
                    let _ = self.repository.interrupt_job(
                        &detail.summary.id,
                        "The in-memory worker registry was unavailable",
                    );
                    continue;
                }
                let app_for_worker = app.clone();
                let state_for_worker = self.clone();
                tauri::async_runtime::spawn(async move {
                    state_for_worker
                        .run_job(app_for_worker, detail.summary.id, active)
                        .await;
                });
            }
            emit_queue(&app, &self.repository);
            if !self.manager.finish_dispatch_pass() {
                break;
            }
        }
    }

    async fn run_job(&self, app: AppHandle, job_id: String, active: Arc<ActiveJob>) {
        let outcome = self.execute_job(&app, &job_id, &active).await;
        if let Err(error) = outcome {
            let detail = self.repository.job_detail(&job_id).ok();
            if let Some(detail) = detail {
                if let (Some(workspace), Ok(output)) = (
                    detail.working_directory.as_deref().map(PathBuf::from),
                    canonical_output_directory(&detail.request.output_directory),
                ) {
                    safe_cleanup_workspace(&workspace, &output, &job_id);
                }
            }
            let result = if active.cancelled.load(Ordering::Acquire)
                || matches!(error, AppError::Cancelled(_))
            {
                self.repository.cancel_persisted_job(&job_id)
            } else {
                self.repository
                    .fail_job(&job_id, error.code(), &error.public_message())
            };
            if let Ok(job) = result {
                emit_job(&app, &self.repository, &job);
            }
        }
        self.manager.remove(&job_id);
        emit_queue(&app, &self.repository);
        self.dispatch(app);
    }

    async fn execute_job(
        &self,
        app: &AppHandle,
        job_id: &str,
        active: &Arc<ActiveJob>,
    ) -> AppResult<()> {
        let detail = self.repository.job_detail(job_id)?;
        validate_enqueue_item(&detail.request)?;
        let settings = self.repository.get_settings()?.settings;
        let output_directory = canonical_output_directory(&detail.request.output_directory)?;
        ensure_free_space(&output_directory, &detail.request, &settings)?;
        let workspace = prepare_workspace(&output_directory, job_id)?;
        *active
            .workspace
            .lock()
            .map_err(|_| AppError::Internal("The job workspace lock failed".into()))? =
            Some(workspace.clone());
        transition(
            app,
            &self.repository,
            job_id,
            JobState::Preparing,
            "Preparing isolated workspace",
            Some(&workspace),
        )?;

        let staged_input = match &detail.request.source {
            SourceSpec::Youtube { url } => {
                if detail.request.inspection.is_live {
                    return Err(invalid("Live videos cannot be exported"));
                }
                transition(
                    app,
                    &self.repository,
                    job_id,
                    JobState::Acquiring,
                    "Acquiring source audio",
                    None,
                )?;
                acquire_youtube(
                    app,
                    &self.repository,
                    job_id,
                    active,
                    url,
                    &workspace,
                    &settings,
                )
                .await?
            }
            SourceSpec::LocalFile { path } => {
                let source = canonical_local_audio(path, settings.max_input_bytes)?;
                verify_local_fingerprint(&source, &detail.request)?;
                if detail.request.export.preset_id == ExportPresetId::Original {
                    transition(
                        app,
                        &self.repository,
                        job_id,
                        JobState::Copying,
                        "Copying original audio",
                        None,
                    )?;
                    let extension = source
                        .extension()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| invalid("The local source extension is invalid"))?;
                    let destination = workspace.join(format!("source.{extension}"));
                    fs::copy(&source, &destination)?;
                    verify_local_fingerprint(&source, &detail.request)?;
                    destination
                } else {
                    source
                }
            }
        };
        ensure_not_cancelled(active)?;
        let input_probe = probe_audio(app, &staged_input)?;
        if input_probe
            .audio
            .duration_ms
            .is_some_and(|duration| duration > u64::from(settings.max_duration_minutes) * 60_000)
        {
            return Err(invalid(format!(
                "The acquired source exceeds Sonic's {} minute duration limit",
                settings.max_duration_minutes
            )));
        }
        if fs::metadata(&staged_input)?.len() > settings.max_input_bytes {
            return Err(invalid(
                "The acquired source exceeds Sonic's input size limit",
            ));
        }

        let staged_audio = if detail.request.export.preset_id == ExportPresetId::Original {
            staged_input
        } else {
            transition(
                app,
                &self.repository,
                job_id,
                JobState::Transcoding,
                "Transcoding producer export",
                None,
            )?;
            let extension = preset_extension(detail.request.export.preset_id, None)?;
            let output = workspace.join(format!("export.{extension}"));
            let args = ffmpeg_transcode_args(
                &staged_input,
                &output,
                &detail.request.export,
                &detail.request.metadata,
            )?;
            let command = media_command(app, "ffmpeg")?;
            run_process(
                app,
                &self.repository,
                job_id,
                active,
                command,
                args,
                ProcessKind::Ffmpeg {
                    duration_ms: detail.request.inspection.audio.duration_ms,
                },
            )
            .await?;
            output
        };
        ensure_not_cancelled(active)?;

        transition(
            app,
            &self.repository,
            job_id,
            JobState::Validating,
            "Validating audio and metadata",
            None,
        )?;
        let output_probe = probe_audio(app, &staged_audio)?;
        let output_hash = sha256_file(&staged_audio)?;
        let tag_status = verify_tag_readback(&detail.request, &output_probe.tags);
        let library_item_id = Uuid::new_v4().to_string();
        let created = now_ms();
        let sidecar = build_sidecar(SidecarBuild {
            library_item_id: &library_item_id,
            job_id,
            client_item_id: detail.request.client_item_id.as_deref(),
            created_at_ms: created,
            inspection: &detail.request.inspection,
            metadata: &detail.request.metadata,
            output_audio: &output_probe.audio,
            export: &detail.request.export,
            output_sha256: &output_hash,
            include_source_path: settings.include_source_path_in_sidecar,
            tag_status,
        });
        let staged_sidecar = write_sidecar(&workspace, &sidecar)?;
        transition(
            app,
            &self.repository,
            job_id,
            JobState::Publishing,
            "Publishing audio and metadata",
            None,
        )?;
        ensure_not_cancelled(active)?;
        let original_extension = staged_audio.extension().and_then(|value| value.to_str());
        let filename = render_filename(
            &detail.request.filename_template,
            &detail.request.metadata,
            detail.request.export.preset_id,
            original_extension,
            Some(&detail.request.source),
        )?;
        let published = publish_pair(
            job_id,
            &staged_audio,
            &staged_sidecar,
            &workspace,
            &output_directory,
            &filename.stem,
        )?;
        let library = library_item_from_sidecar(
            &sidecar,
            &published.audio_path,
            &published.sidecar_path,
            Some(&detail.request.source),
            detail.request.inspection.thumbnail_url.clone(),
        )?;
        if settings.history_enabled {
            self.repository.insert_library_item(&library)?;
        }
        let completed =
            self.repository
                .complete_job(job_id, &published.audio_path, &published.sidecar_path)?;
        safe_cleanup_workspace(&workspace, &output_directory, job_id);
        emit_job(app, &self.repository, &completed);
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> AppResult<QueueJob> {
        let detail = self.repository.job_detail(job_id)?;
        if detail.summary.state.is_terminal() {
            return Err(crate::error::conflict("The queue job has already finished"));
        }
        if detail.summary.state == JobState::Publishing {
            return Err(crate::error::conflict(
                "The job is already publishing its final files",
            ));
        }
        if detail.summary.state == JobState::Queued {
            return self.repository.cancel_persisted_job(job_id);
        }
        let active = self
            .manager
            .get(job_id)
            .ok_or_else(|| crate::error::conflict("The active process is unavailable"))?;
        active.cancelled.store(true, Ordering::Release);
        terminate_active(&active);
        Ok(detail.summary)
    }

    pub fn shutdown(&self) {
        let active = self.manager.drain();
        for (id, job) in active {
            job.cancelled.store(true, Ordering::Release);
            terminate_active(&job);
            let _ = self
                .repository
                .interrupt_job(&id, "Sonic closed while this job was running");
        }
    }
}

#[derive(Clone, Default)]
struct JobManager {
    active: Arc<Mutex<HashMap<String, Arc<ActiveJob>>>>,
    dispatching: Arc<AtomicBool>,
    dispatch_requested: Arc<AtomicBool>,
}

impl JobManager {
    fn request_dispatch(&self) -> bool {
        self.dispatch_requested.store(true, Ordering::Release);
        self.dispatching
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn begin_dispatch_pass(&self) {
        self.dispatch_requested.store(false, Ordering::Release);
    }

    fn finish_dispatch_pass(&self) -> bool {
        // Release ownership before checking the coalesced wakeup. A request racing before this
        // store is observed below and replayed by this worker; a request racing after it either
        // starts a new worker or prevents this worker from reacquiring ownership.
        self.dispatching.store(false, Ordering::Release);
        self.dispatch_requested.load(Ordering::Acquire)
            && self
                .dispatching
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    fn insert(&self, id: String, job: Arc<ActiveJob>) -> AppResult<()> {
        self.active
            .lock()
            .map_err(|_| AppError::Internal("The job manager is unavailable".into()))?
            .insert(id, job);
        Ok(())
    }

    fn get(&self, id: &str) -> Option<Arc<ActiveJob>> {
        self.active.lock().ok()?.get(id).cloned()
    }

    fn remove(&self, id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(id);
        }
    }

    fn active_count(&self) -> usize {
        self.active.lock().map(|active| active.len()).unwrap_or(0)
    }

    fn drain(&self) -> Vec<(String, Arc<ActiveJob>)> {
        self.active
            .lock()
            .map(|mut active| active.drain().collect())
            .unwrap_or_default()
    }
}

#[derive(Default)]
struct ActiveJob {
    child: Mutex<Option<CommandChild>>,
    cancelled: AtomicBool,
    workspace: Mutex<Option<PathBuf>>,
}

enum ProcessKind {
    YtDlp,
    Ffmpeg { duration_ms: Option<u64> },
}

#[derive(Default)]
struct ProcessOutput {
    reported_output: Option<String>,
}

async fn acquire_youtube(
    app: &AppHandle,
    repository: &Repository,
    job_id: &str,
    active: &Arc<ActiveJob>,
    input: &str,
    workspace: &Path,
    settings: &AppSettings,
) -> AppResult<PathBuf> {
    let url = validate_youtube_url(input)?;
    let js_runtime = bundled_js_runtime(app)?;
    let ffmpeg_directory = ffmpeg_directory(app)?;
    let args = vec![
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--no-update".to_string(),
        "--no-plugin-dirs".to_string(),
        "--no-remote-components".to_string(),
        "--js-runtimes".to_string(),
        js_runtime,
        "--match-filter".to_string(),
        "!is_live".to_string(),
        "--socket-timeout".to_string(),
        "20".to_string(),
        "--retries".to_string(),
        "5".to_string(),
        "--fragment-retries".to_string(),
        "5".to_string(),
        "--file-access-retries".to_string(),
        "3".to_string(),
        "--concurrent-fragments".to_string(),
        "4".to_string(),
        "--newline".to_string(),
        "--no-colors".to_string(),
        "--progress".to_string(),
        "--progress-template".to_string(),
        "download:SONIC_PROGRESS:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s".to_string(),
        "--print".to_string(),
        "after_move:SONIC_OUTPUT:%(filepath)s".to_string(),
        "--windows-filenames".to_string(),
        "--no-overwrites".to_string(),
        "--max-filesize".to_string(),
        settings.max_input_bytes.to_string(),
        "--paths".to_string(),
        workspace.to_string_lossy().into_owned(),
        "--output".to_string(),
        "source.%(ext)s".to_string(),
        "--format".to_string(),
        "bestaudio/best".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_directory.to_string_lossy().into_owned(),
        "--".to_string(),
        url,
    ];
    let result = run_process(
        app,
        repository,
        job_id,
        active,
        yt_dlp_command(app)?,
        args,
        ProcessKind::YtDlp,
    )
    .await?;
    if let Some(path) = result.reported_output {
        if let Some(path) = validated_workspace_file(Path::new(&path), workspace) {
            return Ok(path);
        }
    }
    find_workspace_audio(workspace, "source")
        .ok_or_else(|| AppError::Process("yt-dlp finished without a valid audio output".into()))
}

async fn run_process(
    app: &AppHandle,
    repository: &Repository,
    job_id: &str,
    active: &Arc<ActiveJob>,
    command: ShellCommand,
    args: Vec<String>,
    kind: ProcessKind,
) -> AppResult<ProcessOutput> {
    ensure_not_cancelled(active)?;
    let (mut receiver, child) = command
        .args(args)
        .spawn()
        .map_err(|error| AppError::Process(format!("Could not start media process: {error}")))?;
    *active
        .child
        .lock()
        .map_err(|_| AppError::Internal("The child-process lock failed".into()))? = Some(child);
    if active.cancelled.load(Ordering::Acquire) {
        terminate_active(active);
    }
    let mut exit_code = None;
    let mut output = ProcessOutput::default();
    let mut last_error = None;
    let mut last_percent = -1.0_f64;
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                for line in String::from_utf8_lossy(&bytes).lines().map(str::trim) {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some(path) = line.strip_prefix("SONIC_OUTPUT:") {
                        output.reported_output = Some(path.trim().to_string());
                    }
                    let progress = match kind {
                        ProcessKind::YtDlp => parse_ytdlp_progress(line),
                        ProcessKind::Ffmpeg { duration_ms } => {
                            parse_ffmpeg_progress(line, duration_ms)
                        }
                    };
                    if let Some(progress) = progress {
                        let percent = progress.percent.unwrap_or(last_percent);
                        if (percent - last_percent).abs() >= 1.0 || percent >= 100.0 {
                            last_percent = percent;
                            if let Ok(job) = repository.update_progress(job_id, &progress) {
                                emit_job(app, repository, &job);
                            }
                        }
                    }
                    if line.contains("ERROR:") || line.to_ascii_lowercase().contains("error") {
                        last_error = Some(limited_text(line));
                    }
                }
            }
            CommandEvent::Error(error) => last_error = Some(limited_text(&error)),
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }
    if let Ok(mut child) = active.child.lock() {
        child.take();
    }
    ensure_not_cancelled(active)?;
    if exit_code != Some(0) {
        return Err(AppError::Process(last_error.unwrap_or_else(
            || match exit_code {
                Some(code) => format!("Media process exited with code {code}"),
                None => "The media process ended unexpectedly".into(),
            },
        )));
    }
    Ok(output)
}

pub fn validate_enqueue_item(request: &EnqueueItem) -> AppResult<()> {
    if request.source != request.inspection.source {
        return Err(invalid("The source does not match its inspection"));
    }
    if request.inspection.is_live {
        return Err(invalid("Live sources cannot be exported"));
    }
    if request.inspection.source_fingerprint.len() > 96
        || request
            .inspection
            .source_fingerprint
            .chars()
            .any(char::is_whitespace)
    {
        return Err(invalid("The source fingerprint is invalid"));
    }
    if let Some(expected) = &request.expected_fingerprint {
        if expected != &request.inspection.source_fingerprint {
            return Err(invalid("The source changed after inspection"));
        }
    }
    if let Some(client_id) = &request.client_item_id {
        if client_id.is_empty()
            || client_id.len() > 64
            || !client_id.chars().all(|value| {
                value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.')
            })
        {
            return Err(invalid(
                "clientItemId must be a safe 1 to 64 character identifier",
            ));
        }
    }
    validate_export(&request.export)?;
    validate_metadata(&request.metadata)?;
    canonical_output_directory(&request.output_directory)?;
    let original_extension = source_extension(request);
    render_filename(
        &request.filename_template,
        &request.metadata,
        request.export.preset_id,
        original_extension.as_deref(),
        Some(&request.source),
    )?;
    Ok(())
}

fn verify_local_fingerprint(path: &Path, request: &EnqueueItem) -> AppResult<()> {
    let actual = format!("sha256:{}", sha256_file(path)?);
    let expected = request
        .expected_fingerprint
        .as_deref()
        .unwrap_or(&request.inspection.source_fingerprint);
    if actual != expected {
        return Err(invalid(
            "The local source changed after inspection; inspect it again",
        ));
    }
    Ok(())
}

fn transition(
    app: &AppHandle,
    repository: &Repository,
    id: &str,
    state: JobState,
    message: &str,
    workspace: Option<&Path>,
) -> AppResult<QueueJob> {
    let job = repository.update_job_state(
        id,
        state,
        &JobProgress {
            message: Some(message.to_string()),
            ..Default::default()
        },
        workspace,
    )?;
    emit_job(app, repository, &job);
    Ok(job)
}

fn emit_job(app: &AppHandle, repository: &Repository, job: &QueueJob) {
    let _ = app.emit(JOB_UPDATED_EVENT, job.clone());
    let legacy = legacy_progress(job);
    let _ = app.emit(LEGACY_PROGRESS_EVENT, legacy);
    emit_queue(app, repository);
}

fn emit_queue(app: &AppHandle, repository: &Repository) {
    if let Ok(snapshot) = repository.queue_snapshot() {
        let _ = app.emit(QUEUE_UPDATED_EVENT, snapshot);
    }
}

pub fn emit_queue_snapshot(app: &AppHandle, repository: &Repository) {
    emit_queue(app, repository);
}

fn legacy_progress(job: &QueueJob) -> DownloadProgress {
    let status = match job.state {
        JobState::Queued | JobState::Preparing => "queued",
        JobState::Acquiring | JobState::Copying => "downloading",
        JobState::Transcoding | JobState::Tagging | JobState::Validating | JobState::Publishing => {
            "converting"
        }
        JobState::Completed => "completed",
        JobState::Failed | JobState::Interrupted => "failed",
        JobState::Cancelled => "cancelled",
    };
    DownloadProgress {
        job_id: job.id.clone(),
        status: status.to_string(),
        percent: job.progress.percent,
        downloaded_bytes: job.progress.downloaded_bytes,
        total_bytes: job.progress.total_bytes,
        speed_bytes_per_second: job.progress.speed_bytes_per_second,
        eta_seconds: job.progress.eta_seconds,
        output_path: job.output_path.clone(),
        message: job.progress.message.clone(),
        error: job.error_message.clone(),
    }
}

fn parse_ytdlp_progress(line: &str) -> Option<JobProgress> {
    let fields = line
        .strip_prefix("SONIC_PROGRESS:")?
        .split('|')
        .collect::<Vec<_>>();
    if fields.len() < 6 {
        return None;
    }
    Some(JobProgress {
        percent: parse_f64(fields[5]).map(|value| value.clamp(0.0, 100.0)),
        downloaded_bytes: parse_u64(fields[0]),
        total_bytes: parse_u64(fields[1]).or_else(|| parse_u64(fields[2])),
        speed_bytes_per_second: parse_f64(fields[3]),
        eta_seconds: parse_u64(fields[4]),
        message: Some("Acquiring source audio".into()),
    })
}

fn parse_ffmpeg_progress(line: &str, duration_ms: Option<u64>) -> Option<JobProgress> {
    let value = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    let micros = value.trim().parse::<u64>().ok()?;
    let percent = duration_ms
        .filter(|duration| *duration > 0)
        .map(|duration| (micros as f64 / (duration as f64 * 1_000.0) * 100.0).clamp(0.0, 99.0));
    Some(JobProgress {
        percent,
        message: Some("Transcoding producer export".into()),
        ..Default::default()
    })
}

fn parse_f64(value: &str) -> Option<f64> {
    let value = value.trim().trim_end_matches('%');
    if value.is_empty() || matches!(value.to_ascii_lowercase().as_str(), "na" | "none") {
        return None;
    }
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn parse_u64(value: &str) -> Option<u64> {
    parse_f64(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.round() as u64)
}

fn validated_workspace_file(path: &Path, workspace: &Path) -> Option<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    };
    let canonical = path.canonicalize().ok()?;
    (canonical.is_file() && canonical.parent() == Some(workspace)).then_some(canonical)
}

fn find_workspace_audio(workspace: &Path, prefix: &str) -> Option<PathBuf> {
    let prefix = format!("{prefix}.");
    fs::read_dir(workspace)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .file_name()
                    .map(|name| name.to_string_lossy().starts_with(&prefix))
                    .unwrap_or(false)
                && !path.to_string_lossy().ends_with(".part")
        })
        .and_then(|path| path.canonicalize().ok())
}

fn source_extension(request: &EnqueueItem) -> Option<String> {
    match &request.source {
        SourceSpec::LocalFile { path } => Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase),
        SourceSpec::Youtube { .. } => request
            .inspection
            .audio
            .container
            .as_deref()
            .filter(|value| !value.contains(','))
            .map(str::to_ascii_lowercase),
    }
}

fn ensure_not_cancelled(active: &ActiveJob) -> AppResult<()> {
    if active.cancelled.load(Ordering::Acquire) {
        Err(AppError::Cancelled("The export was cancelled".into()))
    } else {
        Ok(())
    }
}

fn ensure_free_space(
    output: &Path,
    request: &EnqueueItem,
    settings: &AppSettings,
) -> AppResult<()> {
    let duration_ms = request.inspection.audio.duration_ms.unwrap_or(60_000);
    let estimated = match request.export.preset_id {
        ExportPresetId::Wav44100S24 => duration_ms.saturating_mul(44_100 * 2 * 3) / 1_000,
        ExportPresetId::Wav48000S24 => duration_ms.saturating_mul(48_000 * 2 * 3) / 1_000,
        ExportPresetId::Flac => duration_ms.saturating_mul(48_000 * 2 * 3) / 2_000,
        _ => request
            .inspection
            .audio
            .file_size_bytes
            .unwrap_or(settings.max_input_bytes.min(512 * 1024 * 1024)),
    };
    let required = estimated
        .saturating_mul(2)
        .saturating_add(256 * 1024 * 1024);
    let available = fs2::available_space(output)?;
    if available < required {
        return Err(invalid(format!(
            "The output drive needs at least {required} free bytes for this export"
        )));
    }
    Ok(())
}

fn verify_tag_readback(request: &EnqueueItem, tags: &HashMap<String, String>) -> TagStatus {
    let requested =
        request.export.write_embedded_tags && request.export.preset_id != ExportPresetId::Original;
    if !requested {
        return TagStatus {
            requested,
            supported: request.export.preset_id != ExportPresetId::Original,
            readback_verified: false,
            warnings: Vec::new(),
        };
    }
    let title_ok = tags
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case("title") && value == &request.metadata.title);
    let bpm_ok = request.metadata.bpm.is_none()
        || tags.keys().any(|key| {
            ["bpm", "tbpm", "tempo"]
                .iter()
                .any(|name| key.eq_ignore_ascii_case(name))
        });
    let key_ok = request.metadata.key.is_none()
        || tags.keys().any(|key| {
            ["key", "tkey", "initialkey"]
                .iter()
                .any(|name| key.eq_ignore_ascii_case(name))
        });
    let verified = title_ok && bpm_ok && key_ok;
    TagStatus {
        requested,
        supported: true,
        readback_verified: verified,
        warnings: (!verified)
            .then(|| "Some container metadata was not visible during ffprobe readback".to_string())
            .into_iter()
            .collect(),
    }
}

fn library_item_from_sidecar(
    sidecar: &SonicSidecar,
    audio_path: &Path,
    sidecar_path: &Path,
    source_override: Option<&SourceSpec>,
    thumbnail_url: Option<String>,
) -> AppResult<LibraryItem> {
    let metadata = fs::metadata(audio_path)?;
    let source = if let Some(source) = source_override {
        source.clone()
    } else {
        match sidecar.source.kind.as_str() {
            "youtube" => SourceSpec::Youtube {
                url: sidecar.source.canonical_url.clone().unwrap_or_default(),
            },
            "localFile" => SourceSpec::LocalFile {
                path: sidecar
                    .source
                    .original_path
                    .clone()
                    .or_else(|| sidecar.source.file_name.clone())
                    .unwrap_or_default(),
            },
            _ => return Err(invalid("The sidecar source kind is invalid")),
        }
    };
    Ok(LibraryItem {
        id: sidecar.library_item_id.clone(),
        job_id: sidecar.job_id.clone(),
        client_item_id: sidecar.client_item_id.clone(),
        source,
        title: sidecar.metadata.title.clone(),
        artist: sidecar.metadata.artist.clone(),
        thumbnail_url,
        bpm: sidecar.metadata.bpm,
        alternate_bpms: sidecar.metadata.alternate_bpms.clone(),
        key: sidecar.metadata.key.clone(),
        camelot: sidecar.metadata.camelot.clone(),
        detune_cents: sidecar.metadata.detune_cents,
        tuning_hz: sidecar.metadata.tuning_hz,
        preset_id: sidecar.export.preset_id,
        format: sidecar
            .output_audio
            .container
            .clone()
            .unwrap_or_else(|| "audio".into()),
        codec: sidecar.output_audio.codec.clone(),
        duration_ms: sidecar.output_audio.duration_ms,
        sample_rate_hz: sidecar.output_audio.sample_rate_hz,
        channels: sidecar.output_audio.channels,
        audio_path: audio_path.to_string_lossy().into_owned(),
        sidecar_path: sidecar_path.to_string_lossy().into_owned(),
        file_size_bytes: metadata.len(),
        sha256: sidecar.output_sha256.clone(),
        missing: false,
        created_at_ms: sidecar.created_at_ms,
        updated_at_ms: sidecar.created_at_ms,
    })
}

fn recover_interrupted_jobs(repository: &Repository) -> AppResult<RecoveryReport> {
    let mut report = RecoveryReport::default();
    for detail in repository.running_jobs_for_recovery()? {
        report.interrupted_jobs += 1;
        let output = canonical_output_directory(&detail.request.output_directory);
        let workspace = detail.working_directory.as_deref().map(PathBuf::from);
        let mut recovered = false;
        if let (Ok(output), Some(workspace)) = (&output, &workspace) {
            if let Ok(Some(journal)) = read_publication_journal(workspace) {
                let audio = PathBuf::from(&journal.audio_path);
                let sidecar_path = PathBuf::from(&journal.sidecar_path);
                let safe_audio = (audio.parent() == Some(output.as_path()))
                    .then(|| canonical_recorded_file(&audio).ok().flatten())
                    .flatten()
                    .filter(|path| path.parent() == Some(output.as_path()));
                let safe_sidecar = (sidecar_path.parent() == Some(output.as_path()))
                    .then(|| canonical_recorded_file(&sidecar_path).ok().flatten())
                    .flatten()
                    .filter(|path| path.parent() == Some(output.as_path()));
                let hashes_match = safe_audio.as_ref().is_some_and(|path| {
                    sha256_file(path).ok().as_deref() == Some(&journal.audio_sha256)
                }) && safe_sidecar.as_ref().is_some_and(|path| {
                    sha256_file(path).ok().as_deref() == Some(&journal.sidecar_sha256)
                });
                if let (true, Some(audio), Some(sidecar_path)) = (
                    journal.job_id == detail.summary.id && hashes_match,
                    safe_audio.as_ref(),
                    safe_sidecar.as_ref(),
                ) {
                    if let Ok(sidecar) = read_sidecar(sidecar_path) {
                        if let Ok(item) = library_item_from_sidecar(
                            &sidecar,
                            audio,
                            sidecar_path,
                            Some(&detail.request.source),
                            detail.request.inspection.thumbnail_url.clone(),
                        ) {
                            let history = repository.get_settings()?.settings.history_enabled;
                            if (!history || repository.insert_library_item(&item).is_ok())
                                && repository
                                    .complete_job(&detail.summary.id, audio, sidecar_path)
                                    .is_ok()
                            {
                                report.recovered_jobs += 1;
                                recovered = true;
                            }
                        }
                    }
                }
                if journal.job_id == detail.summary.id && !recovered {
                    let audio_only = safe_audio
                        .as_ref()
                        .filter(|_| path_is_absent(&sidecar_path));
                    let sidecar_only = safe_sidecar.as_ref().filter(|_| path_is_absent(&audio));
                    if let Some(audio) = audio_only.filter(|path| {
                        sha256_file(path).ok().as_deref() == Some(&journal.audio_sha256)
                    }) {
                        if fs::remove_file(audio).is_ok() {
                            report.warnings.push(format!(
                                "Removed a verified partial audio publication for job {}",
                                detail.summary.id
                            ));
                        }
                    } else if let Some(sidecar_path) = sidecar_only.filter(|path| {
                        sha256_file(path).ok().as_deref() == Some(&journal.sidecar_sha256)
                    }) {
                        if fs::remove_file(sidecar_path).is_ok() {
                            report.warnings.push(format!(
                                "Removed a verified partial metadata publication for job {}",
                                detail.summary.id
                            ));
                        }
                    }
                }
            }
        }
        if !recovered {
            let _ = repository.interrupt_job(
                &detail.summary.id,
                "Sonic recovered this interrupted job; retry it when ready",
            );
        }
        if let (Ok(output), Some(workspace)) = (output, workspace) {
            if safe_cleanup_workspace(&workspace, &output, &detail.summary.id) {
                report.cleaned_workspaces += 1;
            } else if workspace.exists() {
                report.warnings.push(format!(
                    "Could not safely clean workspace for job {}",
                    detail.summary.id
                ));
            }
        }
    }
    Ok(report)
}

fn path_is_absent(path: &Path) -> bool {
    fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn terminate_active(active: &ActiveJob) {
    let child = active.child.lock().ok().and_then(|mut child| child.take());
    if let Some(child) = child {
        terminate_child(child);
    }
}

#[cfg(windows)]
fn terminate_child(child: CommandChild) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = child.pid().to_string();
    let killed = std::process::Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !killed {
        let _ = child.kill();
    }
}

#[cfg(not(windows))]
fn terminate_child(child: CommandChild) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        metadata::MusicMetadata,
        models::{AudioProperties, ExportSpec, FinalMetadata, SourceInspection},
    };

    fn request() -> EnqueueItem {
        let source = SourceSpec::LocalFile {
            path: "C:\\beat.wav".into(),
        };
        EnqueueItem {
            client_item_id: Some("client-1".into()),
            source: source.clone(),
            expected_fingerprint: Some("sha256:abc".into()),
            inspection: SourceInspection {
                id: "inspection".into(),
                source,
                source_fingerprint: "sha256:abc".into(),
                title: "Beat".into(),
                artist: None,
                description: None,
                thumbnail_url: None,
                webpage_url: None,
                is_live: false,
                audio: AudioProperties {
                    container: Some("wav".into()),
                    codec: Some("pcm_s16le".into()),
                    sample_rate_hz: Some(44_100),
                    channels: Some(2),
                    bit_depth: Some(16),
                    duration_ms: Some(1_000),
                    file_size_bytes: Some(1_000),
                },
                declared_metadata: MusicMetadata::default(),
                embedded_metadata: MusicMetadata::default(),
                suggested_metadata: MusicMetadata::default(),
                warnings: vec![],
            },
            metadata: FinalMetadata {
                title: "Beat".into(),
                bpm: Some(140.0),
                ..Default::default()
            },
            export: ExportSpec::default(),
            output_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            filename_template: "{title} - {bpm}".into(),
        }
    }

    #[test]
    fn parses_structured_download_progress() {
        let progress =
            parse_ytdlp_progress("SONIC_PROGRESS:524288|1048576|NA|262144|2| 50.0%").unwrap();
        assert_eq!(progress.percent, Some(50.0));
        assert_eq!(progress.downloaded_bytes, Some(524_288));
        assert_eq!(progress.total_bytes, Some(1_048_576));
        assert_eq!(progress.eta_seconds, Some(2));
    }

    #[test]
    fn parses_ffmpeg_microsecond_progress() {
        let progress = parse_ffmpeg_progress("out_time_us=5000000", Some(10_000)).unwrap();
        assert_eq!(progress.percent, Some(50.0));
    }

    #[test]
    fn enqueue_contract_rejects_mismatch_and_unsafe_client_ids() {
        let mut value = request();
        value.inspection.source = SourceSpec::Youtube {
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
        };
        assert!(validate_enqueue_item(&value).is_err());
        value.inspection.source = value.source.clone();
        value.client_item_id = Some("bad client id".into());
        assert!(validate_enqueue_item(&value).is_err());
    }

    #[test]
    fn dispatcher_replays_a_wakeup_that_arrives_during_shutdown() {
        let manager = JobManager::default();

        assert!(manager.request_dispatch());
        manager.begin_dispatch_pass();

        // This is the old lost-wakeup window: a second dispatch request observes the current
        // owner immediately before that owner is ready to release the dispatching flag.
        assert!(!manager.request_dispatch());
        assert!(manager.finish_dispatch_pass());

        manager.begin_dispatch_pass();
        assert!(!manager.finish_dispatch_pass());
        assert!(!manager.dispatching.load(Ordering::Acquire));
    }
}
