use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::Command as ShellCommand, ShellExt};

use crate::{
    error::{AppError, AppResult},
    models::{DependencyInfo, DependencyStatus},
};

pub async fn dependency_status(app: &AppHandle) -> DependencyStatus {
    let mut dependencies = Vec::with_capacity(5);
    dependencies.push(check_yt_dlp(app).await);
    dependencies.push(check_python(app).await);
    dependencies.push(check_media_tool(app, "deno", &["--version"]));
    dependencies.push(check_media_tool(app, "ffmpeg", &["-version"]));
    dependencies.push(check_media_tool(app, "ffprobe", &["-version"]));
    DependencyStatus {
        ready: dependencies.iter().all(|item| item.available),
        dependencies,
    }
}

pub async fn prepare_media_engine(app: AppHandle) -> AppResult<String> {
    let manifest = runtime_resource_path(&app, "tool-manifest.json")?;
    let installer = runtime_resource_path(&app, "install-media-engine.ps1")?;
    let install_directory = media_engine_directory(&app)?;
    let powershell = windows_powershell_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        run_media_engine_installer(&powershell, &installer, &manifest, &install_directory)
    })
    .await
    .map_err(|error| AppError::Internal(format!("Media engine setup task failed: {error}")))?
}

fn run_media_engine_installer(
    powershell: &Path,
    installer: &Path,
    manifest: &Path,
    install_directory: &Path,
) -> AppResult<String> {
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
    configure_std_command(&mut command, None);
    let output = command.output().map_err(|error| {
        AppError::Engine(format!("Could not start media engine setup: {error}"))
    })?;
    if !output.status.success() {
        let stderr = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(AppError::Engine(if stderr.is_empty() {
            format!("Media engine setup exited with status {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn runtime_resource_path(app: &AppHandle, name: &str) -> AppResult<PathBuf> {
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
            .join(name);
        if development.is_file() {
            return Ok(development);
        }
    }
    Err(AppError::Engine(format!(
        "A required Sonic resource is missing: {name}"
    )))
}

pub fn media_engine_directory(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join("media-engine"))
        .map_err(|error| {
            AppError::Engine(format!(
                "Could not resolve Sonic's local media engine folder: {error}"
            ))
        })
}

#[cfg(windows)]
fn windows_powershell_path() -> AppResult<PathBuf> {
    let system_root = env::var_os("SystemRoot")
        .ok_or_else(|| AppError::Engine("Windows did not provide its system directory".into()))?;
    let powershell = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    powershell.is_file().then_some(powershell).ok_or_else(|| {
        AppError::Engine(
            "Windows PowerShell is unavailable, so Sonic could not prepare its media engine".into(),
        )
    })
}

#[cfg(not(windows))]
fn windows_powershell_path() -> AppResult<PathBuf> {
    Err(AppError::Engine(
        "Automatic media engine setup is currently available on Windows only".into(),
    ))
}

pub fn yt_dlp_command(app: &AppHandle) -> AppResult<ShellCommand> {
    let script = sidecar_data_path(app, "yt-dlp")
        .ok_or_else(|| AppError::Engine("The bundled yt-dlp package could not be found".into()))?;
    let command = app.shell().sidecar("python").map_err(|error| {
        AppError::Engine(format!(
            "Could not start the bundled Python runtime: {error}"
        ))
    })?;
    Ok(restrict_shell_command(command).args(["-I", &script.to_string_lossy()]))
}

pub fn media_command(app: &AppHandle, name: &str) -> AppResult<ShellCommand> {
    let executable = media_tool_path(app, name)?;
    let parent = executable.parent().map(Path::to_path_buf);
    Ok(restrict_shell_command(app.shell().command(executable)).env(
        "PATH",
        parent
            .as_deref()
            .unwrap_or_else(|| Path::new(""))
            .as_os_str(),
    ))
}

pub fn bundled_js_runtime(app: &AppHandle) -> AppResult<String> {
    let path = media_tool_path(app, "deno")?;
    Ok(format!("deno:{}", path.to_string_lossy()))
}

pub fn ffmpeg_directory(app: &AppHandle) -> AppResult<PathBuf> {
    let ffmpeg = media_tool_path(app, "ffmpeg")?;
    let ffprobe = media_tool_path(app, "ffprobe")?;
    let directory = ffmpeg
        .parent()
        .ok_or_else(|| AppError::Engine("The verified FFmpeg path has no parent directory".into()))?
        .to_path_buf();
    if ffprobe.parent() != Some(directory.as_path()) {
        return Err(AppError::Engine(
            "The verified FFmpeg and ffprobe executables are not colocated".into(),
        ));
    }
    Ok(directory)
}

pub fn media_tool_path(app: &AppHandle, name: &str) -> AppResult<PathBuf> {
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
            .map_err(|error| AppError::Engine(format!("Could not verify {name}: {error}")))?;
        if actual_hash != expected_hash {
            return Err(AppError::Engine(format!(
                "The local {name} executable failed checksum validation"
            )));
        }
        return Ok(canonical_candidate);
    }
    Err(AppError::Engine(format!(
        "The verified local {name} executable is not installed"
    )))
}

fn expected_media_tool_hash(app: &AppHandle, name: &str) -> AppResult<String> {
    if !matches!(name, "ffmpeg" | "ffprobe" | "deno") {
        return Err(AppError::Engine(format!(
            "No media-engine hash is configured for {name}"
        )));
    }
    let manifest = fs::read_to_string(runtime_resource_path(app, "tool-manifest.json")?)
        .map_err(|error| AppError::Engine(format!("Could not read tool manifest: {error}")))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest)
        .map_err(|error| AppError::Engine(format!("Could not parse tool manifest: {error}")))?;
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
        .ok_or_else(|| {
            AppError::Engine(format!("The tool manifest has no valid hash for {name}"))
        })?;
    Ok(hash.to_ascii_lowercase())
}

async fn check_python(app: &AppHandle) -> DependencyInfo {
    let command = match app.shell().sidecar("python") {
        Ok(command) => restrict_shell_command(command),
        Err(error) => return dependency_failure("python", error.to_string()),
    };
    match command.arg("--version").output().await {
        Ok(output) if output.status.success() => {
            dependency_success("python", first_version_line(&output.stdout, &output.stderr))
        }
        Ok(output) => dependency_failure(
            "python",
            limited_text(&String::from_utf8_lossy(&output.stderr)),
        ),
        Err(error) => dependency_failure("python", error.to_string()),
    }
}

async fn check_yt_dlp(app: &AppHandle) -> DependencyInfo {
    let command = match yt_dlp_command(app) {
        Ok(command) => command,
        Err(error) => return dependency_failure("yt-dlp", error.public_message()),
    };
    match command.arg("--version").output().await {
        Ok(output) if output.status.success() => {
            dependency_success("yt-dlp", first_version_line(&output.stdout, &output.stderr))
        }
        Ok(output) => dependency_failure(
            "yt-dlp",
            limited_text(&String::from_utf8_lossy(&output.stderr)),
        ),
        Err(error) => dependency_failure("yt-dlp", error.to_string()),
    }
}

fn check_media_tool(app: &AppHandle, name: &str, args: &[&str]) -> DependencyInfo {
    let executable = match media_tool_path(app, name) {
        Ok(path) => path,
        Err(error) => return dependency_failure(name, error.public_message()),
    };
    let mut command = std::process::Command::new(&executable);
    command.args(args);
    configure_std_command(&mut command, executable.parent());
    match command.output() {
        Ok(output) if output.status.success() => {
            dependency_success(name, first_version_line(&output.stdout, &output.stderr))
        }
        Ok(output) => {
            dependency_failure(name, limited_text(&String::from_utf8_lossy(&output.stderr)))
        }
        Err(error) => dependency_failure(name, error.to_string()),
    }
}

fn dependency_success(name: &str, version: Option<String>) -> DependencyInfo {
    DependencyInfo {
        name: name.to_string(),
        available: true,
        version,
        error: None,
    }
}

fn dependency_failure(name: &str, error: String) -> DependencyInfo {
    DependencyInfo {
        name: name.to_string(),
        available: false,
        version: None,
        error: Some(error),
    }
}

fn first_version_line(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .chain(String::from_utf8_lossy(stderr).lines())
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
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
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("python-runtime");
        if !directories.contains(&development) {
            directories.push(development);
        }
    }
    directories
}

pub fn restrict_shell_command(command: ShellCommand) -> ShellCommand {
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
        command.env("PATH", PathBuf::from(system_root).join("System32"))
    } else {
        command.env("PATH", "")
    }
}

pub fn configure_std_command(command: &mut std::process::Command, path: Option<&Path>) {
    command.env_clear();
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
            command.env(variable, value);
        }
    }
    if let Some(path) = path {
        command.env("PATH", path);
    } else if let Some(system_root) = env::var_os("SystemRoot") {
        command.env("PATH", PathBuf::from(system_root).join("System32"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
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

pub fn limited_text(value: &str) -> String {
    value.trim().chars().take(4_000).collect()
}
