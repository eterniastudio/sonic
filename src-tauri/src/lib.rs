mod metadata;

use std::{
    collections::HashMap,
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{Command as ShellCommand, CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;
use uuid::Uuid;

const PROGRESS_EVENT: &str = "sonic://download-progress";
const MAX_ERROR_LENGTH: usize = 4_000;
const JOB_DIRECTORY_PREFIX: &str = ".sonic-job-";

#[derive(Clone, Default)]
struct DownloadManager {
    jobs: Arc<Mutex<HashMap<String, Arc<RunningJob>>>>,
}

struct RunningJob {
    child: Mutex<Option<CommandChild>>,
    cancelled: AtomicBool,
    working_directory: PathBuf,
    output_directory: PathBuf,
    file_stem: String,
}

impl DownloadManager {
    fn insert(&self, job_id: String, job: Arc<RunningJob>) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "The download manager is unavailable".to_string())?;
        if !jobs.is_empty() {
            return Err("Another download is already running".to_string());
        }
        jobs.insert(job_id, job);
        Ok(())
    }

    fn get(&self, job_id: &str) -> Option<Arc<RunningJob>> {
        self.jobs.lock().ok()?.get(job_id).cloned()
    }

    fn remove(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(job_id);
        }
    }

    fn cancel_all(&self) {
        let jobs = self
            .jobs
            .lock()
            .map(|mut jobs| jobs.drain().map(|(_, job)| job).collect::<Vec<_>>())
            .unwrap_or_default();

        for job in jobs {
            job.cancelled.store(true, Ordering::Release);
            terminate_job(&job);
            cleanup_job_directory(&job.working_directory, &job.output_directory);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    ready: bool,
    dependencies: Vec<DependencyInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    name: String,
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    id: String,
    title: String,
    description: String,
    thumbnail_url: Option<String>,
    duration_seconds: Option<u64>,
    uploader: Option<String>,
    webpage_url: String,
    is_live: bool,
    metadata: metadata::MusicMetadata,
}

#[derive(Deserialize)]
struct YtDlpVideoInfo {
    id: Option<String>,
    title: Option<String>,
    fulltitle: Option<String>,
    description: Option<String>,
    thumbnail: Option<String>,
    duration: Option<f64>,
    uploader: Option<String>,
    channel: Option<String>,
    webpage_url: Option<String>,
    original_url: Option<String>,
    #[serde(default)]
    is_live: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadFormat {
    Original,
    Wav,
    Mp3,
    M4a,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    url: String,
    output_directory: String,
    format: DownloadFormat,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    bpm: Option<f64>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    detune_cents: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStarted {
    job_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    job_id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl DownloadProgress {
    fn status(job_id: &str, status: &str) -> Self {
        Self {
            job_id: job_id.to_string(),
            status: status.to_string(),
            percent: None,
            downloaded_bytes: None,
            total_bytes: None,
            speed_bytes_per_second: None,
            eta_seconds: None,
            output_path: None,
            message: None,
            error: None,
        }
    }
}

#[tauri::command]
async fn check_dependencies(app: AppHandle) -> DependencyStatus {
    let checks = [("python", vec!["--version"])];

    let mut dependencies = Vec::with_capacity(checks.len() + 3);
    dependencies.push(check_yt_dlp(&app).await);
    for (name, args) in checks {
        dependencies.push(check_sidecar(&app, name, &args).await);
    }
    dependencies.push(check_media_tool(&app, "deno", &["--version"]));
    dependencies.push(check_media_tool(&app, "ffmpeg", &["-version"]));
    dependencies.push(check_media_tool(&app, "ffprobe", &["-version"]));

    DependencyStatus {
        ready: dependencies.iter().all(|dependency| dependency.available),
        dependencies,
    }
}

#[tauri::command]
fn get_default_output_dir(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().desktop_dir())
        .map_err(|error| format!("Could not find a Downloads folder: {error}"))?;
    let sonic_directory = base.join("Sonic");
    fs::create_dir_all(&sonic_directory)
        .map_err(|error| format!("Could not create the Sonic output folder: {error}"))?;
    Ok(sonic_directory.to_string_lossy().into_owned())
}

#[tauri::command]
async fn prepare_media_engine(app: AppHandle) -> Result<String, String> {
    let manifest = runtime_resource_path(&app, "tool-manifest.json")?;
    let installer = runtime_resource_path(&app, "install-media-engine.ps1")?;
    let install_directory = media_engine_directory(&app)?;
    let powershell = windows_powershell_path()?;

    tauri::async_runtime::spawn_blocking(move || {
        run_media_engine_installer(&powershell, &installer, &manifest, &install_directory)
    })
    .await
    .map_err(|error| format!("Media engine setup task failed: {error}"))?
}

fn run_media_engine_installer(
    powershell: &Path,
    installer: &Path,
    manifest: &Path,
    install_directory: &Path,
) -> Result<String, String> {
    let mut command = std::process::Command::new(powershell);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(installer);
    command.arg("-ManifestPath").arg(manifest);
    command.arg("-InstallDirectory").arg(install_directory);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|error| format!("Could not start media engine setup: {error}"))?;
    if !output.status.success() {
        let stderr = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(if stderr.is_empty() {
            format!("Media engine setup exited with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn runtime_resource_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Ok(resource_directory) = app.path().resource_dir() {
        let bundled = resource_directory.join(name);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }

    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
            .join("scripts")
            .join(match name {
                "tool-manifest.json" => "tool-manifest.json",
                "install-media-engine.ps1" => "install-media-engine.ps1",
                _ => name,
            });
        if development.is_file() {
            return Ok(development);
        }
    }

    Err(format!("A required Sonic resource is missing: {name}"))
}

fn media_engine_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join("media-engine"))
        .map_err(|error| format!("Could not resolve Sonic's local media engine folder: {error}"))
}

#[cfg(windows)]
fn windows_powershell_path() -> Result<PathBuf, String> {
    let system_root = env::var_os("SystemRoot")
        .ok_or_else(|| "Windows did not provide its system directory".to_string())?;
    let powershell = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if powershell.is_file() {
        Ok(powershell)
    } else {
        Err(
            "Windows PowerShell is unavailable, so Sonic could not prepare its media engine"
                .to_string(),
        )
    }
}

#[cfg(not(windows))]
fn windows_powershell_path() -> Result<PathBuf, String> {
    Err("Automatic media engine setup is currently available on Windows only".to_string())
}

#[tauri::command]
async fn inspect_video(app: AppHandle, url: String) -> Result<VideoInfo, String> {
    let url = validate_youtube_url(&url)?;
    let js_runtime = bundled_js_runtime(&app)?;
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
        url.clone(),
    ];

    let command = yt_dlp_command(&app)?;
    let output = command
        .args(args)
        .output()
        .await
        .map_err(|error| format!("Could not inspect the video: {error}"))?;

    if !output.status.success() {
        let stderr = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(if stderr.is_empty() {
            "yt-dlp could not inspect this video".to_string()
        } else {
            stderr
        });
    }

    let raw: YtDlpVideoInfo = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("yt-dlp returned invalid video metadata: {error}"))?;
    let id = raw
        .id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "The video metadata did not include an ID".to_string())?;
    let title = raw
        .title
        .or(raw.fulltitle)
        .filter(|title| !title.trim().is_empty())
        .ok_or_else(|| "The video metadata did not include a title".to_string())?;
    let description = raw.description.unwrap_or_default();
    let music_metadata = metadata::parse_music_metadata(&title, &description);

    Ok(VideoInfo {
        id,
        title,
        description,
        thumbnail_url: raw.thumbnail,
        duration_seconds: raw
            .duration
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.round() as u64),
        uploader: raw.uploader.or(raw.channel),
        webpage_url: raw.webpage_url.or(raw.original_url).unwrap_or(url),
        is_live: raw.is_live,
        metadata: music_metadata,
    })
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    request: DownloadRequest,
) -> Result<DownloadStarted, String> {
    let url = validate_youtube_url(&request.url)?;
    let js_runtime = bundled_js_runtime(&app)?;
    let ffmpeg_directory = ffmpeg_directory(&app)?;
    let output_directory = prepare_output_directory(&request.output_directory)?;
    let job_id = Uuid::new_v4().to_string();
    let working_directory = prepare_job_directory(&output_directory, &job_id)?;
    let requested_stem = request
        .file_name
        .as_deref()
        .map(strip_known_audio_extension)
        .map(sanitize_file_stem)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback_file_stem(&request, &job_id));
    let file_stem = available_file_stem(&output_directory, &requested_stem);
    let output_template = format!("{file_stem}.%(ext)s");

    let mut args = vec![
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
        "--paths".to_string(),
        working_directory.to_string_lossy().into_owned(),
        "--output".to_string(),
        output_template,
        "--format".to_string(),
        "bestaudio/best".to_string(),
    ];

    match request.format {
        DownloadFormat::Original => {}
        DownloadFormat::Wav => add_audio_conversion_args(&mut args, "wav", None),
        DownloadFormat::Mp3 => add_audio_conversion_args(&mut args, "mp3", Some("320K")),
        DownloadFormat::M4a => add_audio_conversion_args(&mut args, "m4a", None),
    }

    args.push("--ffmpeg-location".to_string());
    args.push(ffmpeg_directory.to_string_lossy().into_owned());
    args.push("--".to_string());
    args.push(url);

    let command = match yt_dlp_command(&app) {
        Ok(command) => command,
        Err(error) => {
            cleanup_job_directory(&working_directory, &output_directory);
            return Err(format!("Could not start yt-dlp: {error}"));
        }
    };
    let (receiver, child) = match command.args(args).spawn() {
        Ok(process) => process,
        Err(error) => {
            cleanup_job_directory(&working_directory, &output_directory);
            return Err(format!("Could not start the download: {error}"));
        }
    };

    let job = Arc::new(RunningJob {
        child: Mutex::new(Some(child)),
        cancelled: AtomicBool::new(false),
        working_directory: working_directory.clone(),
        output_directory: output_directory.clone(),
        file_stem: file_stem.clone(),
    });
    if let Err(error) = manager.insert(job_id.clone(), job.clone()) {
        terminate_job(&job);
        cleanup_job_directory(&working_directory, &output_directory);
        return Err(error);
    }

    emit_progress(
        &app,
        DownloadProgress {
            percent: Some(0.0),
            message: Some("Download queued".to_string()),
            ..DownloadProgress::status(&job_id, "queued")
        },
    );

    let app_for_task = app.clone();
    let manager_for_task = manager.inner().clone();
    let job_id_for_task = job_id.clone();
    tauri::async_runtime::spawn(async move {
        monitor_download(
            app_for_task,
            manager_for_task,
            job_id_for_task,
            job,
            receiver,
        )
        .await;
    });

    Ok(DownloadStarted { job_id })
}

#[tauri::command]
fn cancel_download(manager: State<'_, DownloadManager>, job_id: String) -> Result<bool, String> {
    let Some(job) = manager.get(&job_id) else {
        return Ok(false);
    };

    let has_process = job
        .child
        .lock()
        .map_err(|_| "The download process is unavailable".to_string())?
        .is_some();
    if !has_process {
        return Ok(false);
    }

    job.cancelled.store(true, Ordering::Release);
    terminate_job(&job);
    Ok(true)
}

async fn check_sidecar(app: &AppHandle, name: &str, args: &[&str]) -> DependencyInfo {
    let command = match app.shell().sidecar(name) {
        Ok(command) => command,
        Err(error) => {
            return DependencyInfo {
                name: name.to_string(),
                available: false,
                version: None,
                error: Some(error.to_string()),
            };
        }
    };

    match with_restricted_child_environment(command)
        .args(args)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = stdout
                .lines()
                .chain(stderr.lines())
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string());
            DependencyInfo {
                name: name.to_string(),
                available: true,
                version,
                error: None,
            }
        }
        Ok(output) => DependencyInfo {
            name: name.to_string(),
            available: false,
            version: None,
            error: Some(limited_text(&String::from_utf8_lossy(&output.stderr))),
        },
        Err(error) => DependencyInfo {
            name: name.to_string(),
            available: false,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

async fn check_yt_dlp(app: &AppHandle) -> DependencyInfo {
    let command = match yt_dlp_command(app) {
        Ok(command) => command,
        Err(error) => {
            return DependencyInfo {
                name: "yt-dlp".to_string(),
                available: false,
                version: None,
                error: Some(error),
            };
        }
    };

    match command.arg("--version").output().await {
        Ok(output) if output.status.success() => DependencyInfo {
            name: "yt-dlp".to_string(),
            available: true,
            version: String::from_utf8_lossy(&output.stdout)
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string()),
            error: None,
        },
        Ok(output) => DependencyInfo {
            name: "yt-dlp".to_string(),
            available: false,
            version: None,
            error: Some(limited_text(&String::from_utf8_lossy(&output.stderr))),
        },
        Err(error) => DependencyInfo {
            name: "yt-dlp".to_string(),
            available: false,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

async fn monitor_download(
    app: AppHandle,
    manager: DownloadManager,
    job_id: String,
    job: Arc<RunningJob>,
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
) {
    let mut exit_code = None;
    let mut reported_output = None;
    let mut last_error = None;

    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if line.is_empty() {
                    continue;
                }

                if let Some(path) = line.strip_prefix("SONIC_OUTPUT:") {
                    reported_output = Some(path.trim().to_string());
                    continue;
                }

                if let Some(progress) = parse_progress_line(&line, &job_id) {
                    emit_progress(&app, progress);
                } else if is_conversion_line(&line) {
                    emit_progress(
                        &app,
                        DownloadProgress {
                            message: Some(limited_text(&line)),
                            ..DownloadProgress::status(&job_id, "converting")
                        },
                    );
                }

                if line.contains("ERROR:") {
                    last_error = Some(limited_text(&line));
                }
            }
            CommandEvent::Error(error) => {
                last_error = Some(limited_text(&error));
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    if let Ok(mut child) = job.child.lock() {
        child.take();
    }
    manager.remove(&job_id);

    if job.cancelled.load(Ordering::Acquire) {
        cleanup_job_directory(&job.working_directory, &job.output_directory);
        emit_progress(
            &app,
            DownloadProgress {
                message: Some("Download cancelled".to_string()),
                ..DownloadProgress::status(&job_id, "cancelled")
            },
        );
        return;
    }

    if exit_code == Some(0) {
        let staged_output = reported_output
            .as_deref()
            .and_then(|path| validated_output_path(path, &job.working_directory))
            .or_else(|| find_output_file(&job.working_directory, &job.file_stem));

        if let Some(staged_output) = staged_output {
            match finalize_job_output(
                &staged_output,
                &job.working_directory,
                &job.output_directory,
                &job.file_stem,
            ) {
                Ok(output_path) => {
                    emit_progress(
                        &app,
                        DownloadProgress {
                            percent: Some(100.0),
                            output_path: Some(output_path),
                            message: Some("Download complete".to_string()),
                            ..DownloadProgress::status(&job_id, "completed")
                        },
                    );
                    return;
                }
                Err(error) => last_error = Some(error),
            }
        } else {
            last_error =
                Some("yt-dlp finished, but Sonic could not find the output file".to_string());
        }
    }

    cleanup_job_directory(&job.working_directory, &job.output_directory);
    let error = last_error.unwrap_or_else(|| match exit_code {
        Some(code) => format!("yt-dlp exited with code {code}"),
        None => "The download process ended unexpectedly".to_string(),
    });
    emit_progress(
        &app,
        DownloadProgress {
            message: Some("Download failed".to_string()),
            error: Some(error),
            ..DownloadProgress::status(&job_id, "failed")
        },
    );
}

fn add_audio_conversion_args(args: &mut Vec<String>, format: &str, quality: Option<&str>) {
    args.push("--extract-audio".to_string());
    args.push("--audio-format".to_string());
    args.push(format.to_string());
    if let Some(quality) = quality {
        args.push("--audio-quality".to_string());
        args.push(quality.to_string());
    }
}

fn with_restricted_child_environment(command: ShellCommand) -> ShellCommand {
    let mut command = command.env_clear();

    for variable in [
        "SystemRoot",
        "TEMP",
        "TMP",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = env::var_os(variable) {
            command = command.env(variable, value);
        }
    }

    if let Some(system_root) = env::var_os("SystemRoot") {
        command = command.env("PATH", PathBuf::from(system_root).join("System32"));
    } else {
        command = command.env("PATH", "");
    }

    command
}

fn yt_dlp_command(app: &AppHandle) -> Result<ShellCommand, String> {
    let script = sidecar_data_path(app, "yt-dlp")
        .ok_or_else(|| "The bundled yt-dlp package could not be found".to_string())?;
    let command = app
        .shell()
        .sidecar("python")
        .map_err(|error| format!("Could not start the bundled Python runtime: {error}"))?;
    Ok(with_restricted_child_environment(command)
        .args(["-I".to_string(), script.to_string_lossy().into_owned()]))
}

fn bundled_js_runtime(app: &AppHandle) -> Result<String, String> {
    let path = media_tool_path(app, "deno")?;
    Ok(format!("deno:{}", path.to_string_lossy()))
}

fn sidecar_data_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    bundled_data_search_directories(app)
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

fn bundled_data_search_directories(_app: &AppHandle) -> Vec<PathBuf> {
    let mut directories = Vec::with_capacity(2);
    if let Some(directory) = env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
    {
        directories.push(directory);
    }

    if cfg!(debug_assertions) {
        let python_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("python-runtime");
        if !directories.contains(&python_runtime) {
            directories.push(python_runtime);
        }
    }
    directories
}

fn ffmpeg_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let ffmpeg = media_tool_path(app, "ffmpeg")?;
    let ffprobe = media_tool_path(app, "ffprobe")?;
    let directory = ffmpeg
        .parent()
        .ok_or_else(|| "The verified FFmpeg path has no parent directory".to_string())?
        .to_path_buf();
    if ffprobe.parent() != Some(directory.as_path()) {
        return Err("The verified FFmpeg and ffprobe executables are not colocated".to_string());
    }
    Ok(directory)
}

fn check_media_tool(app: &AppHandle, name: &str, args: &[&str]) -> DependencyInfo {
    let executable = match media_tool_path(app, name) {
        Ok(executable) => executable,
        Err(error) => {
            return DependencyInfo {
                name: name.to_string(),
                available: false,
                version: None,
                error: Some(error),
            };
        }
    };

    let mut command = std::process::Command::new(&executable);
    command.args(args).env_clear();
    if let Some(directory) = executable.parent() {
        command.env("PATH", directory);
    }
    if let Some(system_root) = env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            DependencyInfo {
                name: name.to_string(),
                available: true,
                version: stdout
                    .lines()
                    .chain(stderr.lines())
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim().to_string()),
                error: None,
            }
        }
        Ok(output) => DependencyInfo {
            name: name.to_string(),
            available: false,
            version: None,
            error: Some(limited_text(&String::from_utf8_lossy(&output.stderr))),
        },
        Err(error) => DependencyInfo {
            name: name.to_string(),
            available: false,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

fn media_tool_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let expected_hash = expected_media_tool_hash(app, name)?;
    let executable_name = platform_executable_name(name);
    let mut directories = vec![media_engine_directory(app)?];
    if cfg!(debug_assertions) {
        directories.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    }

    for directory in directories {
        let Ok(canonical_directory) = directory.canonicalize() else {
            continue;
        };
        let candidate = directory.join(&executable_name);
        let Ok(canonical_candidate) = candidate.canonicalize() else {
            continue;
        };
        if canonical_candidate.parent() != Some(canonical_directory.as_path())
            || !canonical_candidate.is_file()
        {
            continue;
        }
        let actual_hash = sha256_file(&canonical_candidate)
            .map_err(|error| format!("Could not verify {name}: {error}"))?;
        if actual_hash != expected_hash {
            return Err(format!(
                "The local {name} executable failed checksum validation"
            ));
        }
        return Ok(canonical_candidate);
    }

    Err(format!(
        "The verified local {name} executable is not installed"
    ))
}

fn expected_media_tool_hash(app: &AppHandle, name: &str) -> Result<String, String> {
    if name != "ffmpeg" && name != "ffprobe" && name != "deno" {
        return Err(format!("No media-engine hash is configured for {name}"));
    }
    let manifest_path = runtime_resource_path(app, "tool-manifest.json")?;
    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read the media engine manifest: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest)
        .map_err(|error| format!("Could not parse the media engine manifest: {error}"))?;
    let pointer = if name == "deno" {
        "/tools/deno/executable/sha256".to_string()
    } else {
        format!("/tools/ffmpeg/executables/{name}/sha256")
    };
    let hash = manifest
        .pointer(&pointer)
        .and_then(serde_json::Value::as_str)
        .filter(|hash| {
            hash.len() == 64 && hash.chars().all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| format!("The media engine manifest has no valid hash for {name}"))?;
    Ok(hash.to_ascii_lowercase())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(windows)]
fn platform_executable_name(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn platform_executable_name(name: &str) -> String {
    name.to_string()
}

fn validate_youtube_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2_048 {
        return Err("Enter a valid YouTube video URL".to_string());
    }

    let parsed = Url::parse(input).map_err(|_| "Enter a valid YouTube video URL".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Only secure YouTube video URLs are supported".to_string());
    }

    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Enter a valid YouTube video URL".to_string())?;
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let valid = match host.as_str() {
        "youtu.be" | "www.youtu.be" => segments.first().is_some_and(|id| !id.is_empty()),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => match segments
            .first()
            .copied()
        {
            Some("watch") => parsed
                .query_pairs()
                .any(|(key, value)| key == "v" && !value.is_empty()),
            Some("shorts" | "live" | "embed") => segments.get(1).is_some_and(|id| !id.is_empty()),
            _ => false,
        },
        "youtube-nocookie.com" | "www.youtube-nocookie.com" => {
            segments.first() == Some(&"embed") && segments.get(1).is_some_and(|id| !id.is_empty())
        }
        _ => false,
    };

    if !valid {
        return Err("Enter a direct YouTube video, Short, or live-video URL".to_string());
    }

    Ok(parsed.to_string())
}

fn prepare_output_directory(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input.trim());
    if input.trim().is_empty() || !path.is_absolute() {
        return Err("Choose an absolute output folder".to_string());
    }

    fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create the output folder: {error}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not access the output folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("The selected output path is not a folder".to_string());
    }
    Ok(canonical)
}

fn prepare_job_directory(output_directory: &Path, job_id: &str) -> Result<PathBuf, String> {
    let path = output_directory.join(format!("{JOB_DIRECTORY_PREFIX}{job_id}"));
    if path.exists() {
        return Err("Could not create an isolated download workspace".to_string());
    }
    fs::create_dir(&path)
        .map_err(|error| format!("Could not create an isolated download workspace: {error}"))?;
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) => {
            cleanup_job_directory(&path, output_directory);
            return Err(format!(
                "Could not access the isolated download workspace: {error}"
            ));
        }
    };
    if !canonical.starts_with(output_directory) {
        cleanup_job_directory(&path, output_directory);
        return Err("The isolated download workspace escaped the output folder".to_string());
    }
    Ok(canonical)
}

fn strip_known_audio_extension(value: &str) -> &str {
    const EXTENSIONS: &[&str] = &[
        ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm", ".mp4",
    ];
    let lowercase = value.to_ascii_lowercase();
    for extension in EXTENSIONS {
        if lowercase.ends_with(extension) {
            return &value[..value.len() - extension.len()];
        }
    }
    value
}

fn sanitize_file_stem(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len().min(160));
    let mut previous_was_space = false;

    for character in value.chars() {
        if sanitized.chars().count() >= 150 {
            break;
        }
        if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '%'
            )
        {
            continue;
        }
        if character.is_whitespace() {
            if !previous_was_space {
                sanitized.push(' ');
                previous_was_space = true;
            }
        } else {
            sanitized.push(character);
            previous_was_space = false;
        }
    }

    let mut sanitized = sanitized.trim_matches([' ', '.']).to_string();
    let reserved_name = sanitized
        .split('.')
        .next()
        .map(str::to_ascii_uppercase)
        .is_some_and(|name| {
            matches!(
                name.as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
        });
    if reserved_name {
        sanitized.insert(0, '_');
    }
    sanitized
}

fn fallback_file_stem(request: &DownloadRequest, job_id: &str) -> String {
    let mut parts = vec!["Sonic".to_string()];
    if let Some(bpm) = request
        .bpm
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        parts.push(format!("{} BPM", format_number(bpm)));
    }
    if let Some(key) = request
        .key
        .as_deref()
        .map(sanitize_file_stem)
        .filter(|key| !key.is_empty())
    {
        parts.push(key);
    }
    if let Some(cents) = request
        .detune_cents
        .filter(|value| value.is_finite() && value.abs() <= 1_200.0)
    {
        parts.push(format!("{:+}c", cents.round() as i64));
    }
    if parts.len() == 1 {
        parts.push(job_id.chars().take(8).collect());
    }
    sanitize_file_stem(&parts.join(" - "))
}

fn format_number(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

fn available_file_stem(directory: &Path, requested: &str) -> String {
    if !file_stem_exists(directory, requested) {
        return requested.to_string();
    }
    for index in 2..10_000 {
        let candidate = sanitize_file_stem(&format!("{requested} ({index})"));
        if !file_stem_exists(directory, &candidate) {
            return candidate;
        }
    }
    format!("Sonic-{}", Uuid::new_v4())
}

fn file_stem_exists(directory: &Path, stem: &str) -> bool {
    let prefix = format!("{}.", stem.to_lowercase());
    fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .any(|name| name.to_lowercase().starts_with(&prefix))
}

fn parse_progress_line(line: &str, job_id: &str) -> Option<DownloadProgress> {
    if let Some(fields) = line.strip_prefix("SONIC_PROGRESS:") {
        let fields = fields.split('|').collect::<Vec<_>>();
        if fields.len() >= 6 {
            let downloaded = parse_u64(fields[0]);
            let total = parse_u64(fields[1]).or_else(|| parse_u64(fields[2]));
            return Some(DownloadProgress {
                percent: parse_f64(fields[5]).map(|value| value.clamp(0.0, 100.0)),
                downloaded_bytes: downloaded,
                total_bytes: total,
                speed_bytes_per_second: parse_f64(fields[3]),
                eta_seconds: parse_u64(fields[4]),
                message: Some("Downloading audio".to_string()),
                ..DownloadProgress::status(job_id, "downloading")
            });
        }
    }

    let captures = normal_progress_regex().captures(line)?;
    let percent = captures
        .name("percent")
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .map(|value| value.clamp(0.0, 100.0));
    let total_bytes = match (captures.name("size"), captures.name("unit")) {
        (Some(size), Some(unit)) => {
            parse_human_bytes(&format!("{}{}", size.as_str(), unit.as_str()))
        }
        _ => None,
    };
    let downloaded_bytes = percent
        .zip(total_bytes)
        .map(|(percent, total)| (total as f64 * percent / 100.0).round() as u64);
    let speed_bytes_per_second = captures
        .name("speed")
        .and_then(|speed| parse_human_bytes(speed.as_str().trim_end_matches("/s")))
        .map(|speed| speed as f64);
    let eta_seconds = captures.name("eta").and_then(|eta| parse_eta(eta.as_str()));

    Some(DownloadProgress {
        percent,
        downloaded_bytes,
        total_bytes,
        speed_bytes_per_second,
        eta_seconds,
        message: Some("Downloading audio".to_string()),
        ..DownloadProgress::status(job_id, "downloading")
    })
}

fn normal_progress_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?i)\[download\]\s+(?P<percent>\d+(?:\.\d+)?)%\s+of\s+~?\s*(?P<size>\d+(?:\.\d+)?)\s*(?P<unit>[kmgtp]?i?b)(?:\s+at\s+(?P<speed>\S+))?(?:\s+ETA\s+(?P<eta>\d{1,2}:\d{2}(?::\d{2})?))?",
        )
        .expect("the yt-dlp progress expression is valid")
    })
}

fn parse_f64(value: &str) -> Option<f64> {
    let value = value.trim().trim_end_matches('%');
    if value.is_empty() || value.eq_ignore_ascii_case("na") || value.eq_ignore_ascii_case("none") {
        return None;
    }
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn parse_u64(value: &str) -> Option<u64> {
    parse_f64(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.round() as u64)
}

fn parse_human_bytes(value: &str) -> Option<u64> {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let captures = REGEX
        .get_or_init(|| {
            Regex::new(r"(?i)^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?i?b)\s*$")
                .expect("the byte-size expression is valid")
        })
        .captures(value)?;
    let amount = captures.get(1)?.as_str().parse::<f64>().ok()?;
    let unit = captures.get(2)?.as_str().to_ascii_uppercase();
    let binary = unit.contains('I');
    let base = if binary { 1024_f64 } else { 1000_f64 };
    let exponent = match unit.chars().next()? {
        'B' => 0,
        'K' => 1,
        'M' => 2,
        'G' => 3,
        'T' => 4,
        'P' => 5,
        _ => return None,
    };
    Some((amount * base.powi(exponent)).round() as u64)
}

fn parse_eta(value: &str) -> Option<u64> {
    let parts = value
        .split(':')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    match parts.as_slice() {
        [minutes, seconds] => Some(minutes * 60 + seconds),
        [hours, minutes, seconds] => Some(hours * 3_600 + minutes * 60 + seconds),
        _ => None,
    }
}

fn is_conversion_line(line: &str) -> bool {
    [
        "[ExtractAudio]",
        "[Merger]",
        "[VideoConvertor]",
        "[Metadata]",
        "Deleting original file",
    ]
    .iter()
    .any(|marker| line.contains(marker))
}

fn validated_output_path(value: &str, output_directory: &Path) -> Option<String> {
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        output_directory.join(path)
    };
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_file() || !canonical.starts_with(output_directory) {
        return None;
    }
    Some(canonical.to_string_lossy().into_owned())
}

fn find_output_file(output_directory: &Path, file_stem: &str) -> Option<String> {
    let prefix = format!("{}.", file_stem.to_lowercase());
    fs::read_dir(output_directory)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .starts_with(&prefix)
                && entry.path().is_file()
                && !is_temporary_download_file(&entry.path())
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .max_by_key(|(modified, _)| *modified)
        .and_then(|(_, path)| path.canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

fn finalize_job_output(
    staged_output: &str,
    working_directory: &Path,
    output_directory: &Path,
    requested_stem: &str,
) -> Result<String, String> {
    let staged = PathBuf::from(staged_output)
        .canonicalize()
        .map_err(|error| format!("Could not validate the completed audio file: {error}"))?;
    if !staged.is_file() || !staged.starts_with(working_directory) {
        return Err("The completed audio file was outside its staging workspace".to_string());
    }

    let extension = staged
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| {
            !extension.is_empty()
                && extension.len() <= 8
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .ok_or_else(|| "The completed audio file had an invalid extension".to_string())?;
    let mut final_stem = available_file_stem(output_directory, requested_stem);
    let mut collision_count = 0_u16;
    let destination = loop {
        let candidate = output_directory.join(format!("{final_stem}.{extension}"));
        match move_file_no_replace(&staged, &candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                collision_count += 1;
                if collision_count >= 10_000 {
                    return Err("Could not choose an unused output filename".to_string());
                }
                final_stem = available_file_stem(output_directory, requested_stem);
            }
            Err(error) => {
                return Err(format!(
                    "Could not move the completed audio into place: {error}"
                ));
            }
        }
    };
    let canonical = match destination.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(format!("Could not validate the saved audio file: {error}"));
        }
    };
    if !canonical.is_file() || !canonical.starts_with(output_directory) {
        let _ = fs::remove_file(&destination);
        return Err("The saved audio file escaped the selected output folder".to_string());
    }
    cleanup_job_directory(working_directory, output_directory);
    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Omitting MOVEFILE_REPLACE_EXISTING makes publication fail atomically
    // when another process has already created the destination.
    let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

fn cleanup_job_directory(path: &Path, output_directory: &Path) {
    let is_job_directory = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(JOB_DIRECTORY_PREFIX));
    if !is_job_directory {
        return;
    }

    let Ok(canonical_output) = output_directory.canonicalize() else {
        return;
    };
    let Ok(canonical_parent) = path.parent().unwrap_or(Path::new("")).canonicalize() else {
        return;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if canonical_parent == canonical_output
        && metadata.is_dir()
        && !metadata.file_type().is_symlink()
    {
        let _ = fs::remove_dir_all(path);
    }
}

fn is_temporary_download_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.ends_with(".part") || name.ends_with(".ytdl") || name.ends_with(".temp")
}

fn terminate_job(job: &RunningJob) {
    let child = job.child.lock().ok().and_then(|mut child| child.take());
    let Some(child) = child else {
        return;
    };

    terminate_child(child);
}

#[cfg(windows)]
fn terminate_child(child: CommandChild) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = child.pid().to_string();
    let killed_tree = std::process::Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !killed_tree {
        let _ = child.kill();
    }
}

#[cfg(not(windows))]
fn terminate_child(child: CommandChild) {
    let _ = child.kill();
}

fn emit_progress(app: &AppHandle, progress: DownloadProgress) {
    let _ = app.emit(PROGRESS_EVENT, progress);
}

fn limited_text(value: &str) -> String {
    value.trim().chars().take(MAX_ERROR_LENGTH).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DownloadManager::default())
        .invoke_handler(tauri::generate_handler![
            check_dependencies,
            get_default_output_dir,
            prepare_media_engine,
            inspect_video,
            start_download,
            cancel_download
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sonic");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<DownloadManager>().cancel_all();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_direct_youtube_video_urls() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtu.be/dQw4w9WgXcQ?t=1").is_ok());
        assert!(validate_youtube_url("https://youtube.com/shorts/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtube.com/playlist?list=abc").is_err());
        assert!(validate_youtube_url("https://example.com/watch?v=dQw4w9WgXcQ").is_err());
        assert!(validate_youtube_url("http://youtube.com/watch?v=dQw4w9WgXcQ").is_err());
    }

    #[test]
    fn sanitizes_windows_file_names() {
        assert_eq!(
            sanitize_file_stem("  Beat: C#m / 140 BPM?.wav  "),
            "Beat C#m 140 BPM.wav"
        );
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert_eq!(strip_known_audio_extension("beat.WAV"), "beat");
    }

    #[test]
    fn parses_structured_progress() {
        let progress =
            parse_progress_line("SONIC_PROGRESS:524288|1048576|NA|262144|2| 50.0%", "job-1")
                .expect("progress should parse");
        assert_eq!(progress.percent, Some(50.0));
        assert_eq!(progress.downloaded_bytes, Some(524_288));
        assert_eq!(progress.total_bytes, Some(1_048_576));
        assert_eq!(progress.eta_seconds, Some(2));
    }

    #[test]
    fn parses_normal_progress() {
        let progress = parse_progress_line(
            "[download]  25.0% of 10.00MiB at 2.00MiB/s ETA 00:04",
            "job-2",
        )
        .expect("progress should parse");
        assert_eq!(progress.percent, Some(25.0));
        assert_eq!(progress.total_bytes, Some(10 * 1024 * 1024));
        assert_eq!(progress.downloaded_bytes, Some(2_621_440));
        assert_eq!(progress.eta_seconds, Some(4));
    }

    #[test]
    fn parses_sizes_and_eta() {
        assert_eq!(parse_human_bytes("1.5MiB"), Some(1_572_864));
        assert_eq!(parse_human_bytes("2MB"), Some(2_000_000));
        assert_eq!(parse_eta("01:02"), Some(62));
        assert_eq!(parse_eta("01:01:01"), Some(3_661));
    }

    #[test]
    fn applies_explicit_mp3_bitrate_without_claiming_m4a_reencoding() {
        let mut mp3_args = Vec::new();
        add_audio_conversion_args(&mut mp3_args, "mp3", Some("320K"));
        assert_eq!(
            mp3_args,
            [
                "--extract-audio",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "320K"
            ]
        );

        let mut wav_args = Vec::new();
        add_audio_conversion_args(&mut wav_args, "wav", None);
        assert_eq!(wav_args, ["--extract-audio", "--audio-format", "wav"]);

        let mut m4a_args = Vec::new();
        add_audio_conversion_args(&mut m4a_args, "m4a", None);
        assert_eq!(m4a_args, ["--extract-audio", "--audio-format", "m4a"]);
    }

    #[test]
    fn finalizes_from_a_job_staging_directory() {
        let root = env::temp_dir().join(format!("sonic-output-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).expect("test output folder should be created");
        let output_directory = root
            .canonicalize()
            .expect("test output folder should resolve");
        let job_id = Uuid::new_v4().to_string();
        let working_directory =
            prepare_job_directory(&output_directory, &job_id).expect("job workspace should exist");
        let staged = working_directory.join("Night Shift.mp3");
        fs::write(&staged, b"audio").expect("staged audio should be written");

        let finalized = finalize_job_output(
            &staged.to_string_lossy(),
            &working_directory,
            &output_directory,
            "Night Shift",
        )
        .expect("staged audio should be finalized");

        assert!(Path::new(&finalized).is_file());
        assert!(!working_directory.exists());
        fs::remove_dir_all(&root).expect("test output folder should be removed");
    }

    #[test]
    fn finalization_never_clobbers_an_existing_destination() {
        let root = env::temp_dir().join(format!("sonic-collision-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).expect("test output folder should be created");
        let output_directory = root
            .canonicalize()
            .expect("test output folder should resolve");
        let existing = output_directory.join("Night Shift.mp3");
        fs::write(&existing, b"keep me").expect("existing audio should be written");

        let job_id = Uuid::new_v4().to_string();
        let working_directory =
            prepare_job_directory(&output_directory, &job_id).expect("job workspace should exist");
        let staged = working_directory.join("Night Shift.mp3");
        fs::write(&staged, b"new audio").expect("staged audio should be written");

        let finalized = finalize_job_output(
            &staged.to_string_lossy(),
            &working_directory,
            &output_directory,
            "Night Shift",
        )
        .expect("staged audio should be finalized without overwriting");

        assert_eq!(
            fs::read(&existing).expect("existing audio should remain"),
            b"keep me"
        );
        assert_eq!(
            fs::read(&finalized).expect("new audio should be published"),
            b"new audio"
        );
        assert_ne!(Path::new(&finalized), existing);
        fs::remove_dir_all(&root).expect("test output folder should be removed");
    }

    #[test]
    fn atomic_publish_rejects_an_existing_destination() {
        let root = env::temp_dir().join(format!("sonic-atomic-move-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).expect("test folder should be created");
        let source = root.join("source.mp3");
        let destination = root.join("destination.mp3");
        fs::write(&source, b"new audio").expect("source should be written");
        fs::write(&destination, b"keep me").expect("destination should be written");

        let error = move_file_no_replace(&source, &destination)
            .expect_err("publishing over an existing destination must fail");

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read(&destination).expect("destination should remain"),
            b"keep me"
        );
        assert_eq!(
            fs::read(&source).expect("source should remain"),
            b"new audio"
        );
        fs::remove_dir_all(&root).expect("test folder should be removed");
    }
}
