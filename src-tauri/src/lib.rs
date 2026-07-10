mod metadata;

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{Command as ShellCommand, CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;
use uuid::Uuid;

const PROGRESS_EVENT: &str = "sonic://download-progress";
const MAX_ERROR_LENGTH: usize = 4_000;

#[derive(Clone, Default)]
struct DownloadManager {
    jobs: Arc<Mutex<HashMap<String, Arc<RunningJob>>>>,
}

struct RunningJob {
    child: Mutex<Option<CommandChild>>,
    cancelled: AtomicBool,
    output_directory: PathBuf,
    file_stem: String,
}

impl DownloadManager {
    fn insert(&self, job_id: String, job: Arc<RunningJob>) -> Result<(), String> {
        self.jobs
            .lock()
            .map_err(|_| "The download manager is unavailable".to_string())?
            .insert(job_id, job);
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
            cleanup_job_files(&job.output_directory, &job.file_stem);
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
    let checks = [
        ("yt-dlp", vec!["--version"]),
        ("ffmpeg", vec!["-version"]),
        ("ffprobe", vec!["-version"]),
        ("deno", vec!["--version"]),
    ];

    let mut dependencies = Vec::with_capacity(checks.len());
    for (name, args) in checks {
        dependencies.push(check_sidecar(&app, name, &args).await);
    }

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
async fn inspect_video(app: AppHandle, url: String) -> Result<VideoInfo, String> {
    let url = validate_youtube_url(&url)?;
    let args = vec![
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--no-update".to_string(),
        "--no-plugin-dirs".to_string(),
        "--no-remote-components".to_string(),
        "--js-runtimes".to_string(),
        "deno".to_string(),
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

    let command = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|error| format!("Could not start yt-dlp: {error}"))?;
    let output = with_sidecar_path(command)
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
    let output_directory = prepare_output_directory(&request.output_directory)?;
    let job_id = Uuid::new_v4().to_string();
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
        "deno".to_string(),
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
        output_directory.to_string_lossy().into_owned(),
        "--output".to_string(),
        output_template,
        "--format".to_string(),
        "bestaudio/best".to_string(),
    ];

    match request.format {
        DownloadFormat::Original => {}
        DownloadFormat::Wav => add_audio_conversion_args(&mut args, "wav"),
        DownloadFormat::Mp3 => add_audio_conversion_args(&mut args, "mp3"),
        DownloadFormat::M4a => add_audio_conversion_args(&mut args, "m4a"),
    }

    if let Some(executable_directory) = ffmpeg_directory() {
        args.push("--ffmpeg-location".to_string());
        args.push(executable_directory.to_string_lossy().into_owned());
    }
    args.push("--".to_string());
    args.push(url);

    let command = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|error| format!("Could not start yt-dlp: {error}"))?;
    let (receiver, child) = with_sidecar_path(command)
        .args(args)
        .spawn()
        .map_err(|error| format!("Could not start the download: {error}"))?;

    let job = Arc::new(RunningJob {
        child: Mutex::new(Some(child)),
        cancelled: AtomicBool::new(false),
        output_directory: output_directory.clone(),
        file_stem: file_stem.clone(),
    });
    if let Err(error) = manager.insert(job_id.clone(), job.clone()) {
        terminate_job(&job);
        cleanup_job_files(&output_directory, &file_stem);
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

    match with_sidecar_path(command).args(args).output().await {
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
        cleanup_job_files(&job.output_directory, &job.file_stem);
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
        let output_path = reported_output
            .as_deref()
            .and_then(|path| validated_output_path(path, &job.output_directory))
            .or_else(|| find_output_file(&job.output_directory, &job.file_stem));

        if let Some(output_path) = output_path {
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

        last_error = Some("yt-dlp finished, but Sonic could not find the output file".to_string());
    }

    cleanup_job_files(&job.output_directory, &job.file_stem);
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

fn add_audio_conversion_args(args: &mut Vec<String>, format: &str) {
    args.push("--extract-audio".to_string());
    args.push("--audio-format".to_string());
    args.push(format.to_string());
    args.push("--audio-quality".to_string());
    args.push("0".to_string());
}

fn with_sidecar_path(command: ShellCommand) -> ShellCommand {
    let mut paths = sidecar_search_directories();
    if let Some(current_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current_path));
    }

    match env::join_paths(paths) {
        Ok(path) => command.env("PATH", path),
        Err(_) => command,
    }
}

fn sidecar_search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::with_capacity(2);
    if let Some(directory) = env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
    {
        directories.push(directory);
    }

    if cfg!(debug_assertions) {
        let development_binaries = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        if !directories.contains(&development_binaries) {
            directories.push(development_binaries);
        }
    }
    directories
}

fn ffmpeg_directory() -> Option<PathBuf> {
    let directories = sidecar_search_directories();
    directories
        .iter()
        .find(|directory| directory.join(platform_executable_name("ffmpeg")).is_file())
        .cloned()
        .or_else(|| directories.into_iter().next())
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

fn cleanup_job_files(output_directory: &Path, file_stem: &str) {
    let prefix = format!("{}.", file_stem.to_lowercase());
    let Ok(entries) = fs::read_dir(output_directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.starts_with(&prefix) && entry.path().is_file() {
            let _ = fs::remove_file(entry.path());
        }
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
}
