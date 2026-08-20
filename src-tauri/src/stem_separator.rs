use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    error::{AppError, AppResult},
    filesystem::external_path_string,
    tools::{configure_std_command, limited_text, runtime_resource_path},
};

const MODEL: &str = "htdemucs_ft.yaml";
const REQUIRED_STEMS: [&str; 4] = ["vocals", "drums", "bass", "other"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemEngineStatus {
    pub installed: bool,
    pub model: String,
    pub description: String,
}

pub fn status(app: &AppHandle) -> StemEngineStatus {
    let installed = separator_path(app).is_ok();
    StemEngineStatus {
        installed,
        model: "Demucs v4 htdemucs_ft".into(),
        description: if installed {
            "Ready for local vocals, drums, bass, and other separation".into()
        } else {
            "Optional local engine; setup downloads Python ML packages and the model on first use"
                .into()
        },
    }
}

pub fn prepare(app: &AppHandle) -> AppResult<String> {
    let script = runtime_resource_path(app, "install-stem-engine.ps1")?;
    let install_directory = stem_engine_directory(app)?;
    let powershell =
        std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(|| {
            AppError::Engine("Windows did not provide its system directory".into())
        })?)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = std::process::Command::new(&powershell);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command
        .arg(script)
        .arg("-InstallDirectory")
        .arg(&install_directory);
    configure_std_command(&mut command, None);
    let output = command
        .output()
        .map_err(|error| AppError::Engine(format!("Could not start stem-engine setup: {error}")))?;
    if !output.status.success() {
        let message = limited_text(&String::from_utf8_lossy(&output.stderr));
        return Err(AppError::Engine(if message.is_empty() {
            format!("Stem-engine setup exited with status {}", output.status)
        } else {
            message
        }));
    }
    separator_path(app)?;
    Ok(limited_text(&String::from_utf8_lossy(&output.stdout)))
}

pub fn separate(app: &AppHandle, input: &Path) -> AppResult<Vec<String>> {
    let separator = separator_path(app)?;
    let input = input.canonicalize()?;
    if !input.is_file() {
        return Err(AppError::NotFound(
            "The library audio file is missing".into(),
        ));
    }
    let parent = input
        .parent()
        .ok_or_else(|| AppError::InvalidInput("The library audio path is invalid".into()))?;
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Sonic track");
    let output = unique_output_directory(parent, &format!("{stem} - stems"))?;
    fs::create_dir(&output)?;

    let mut command = std::process::Command::new(&separator);
    command
        .arg(&input)
        .args(["--model_filename", MODEL, "--output_dir"])
        .arg(&output)
        .args(["--output_format", "WAV"]);
    configure_std_command(&mut command, separator.parent());
    let result = command.output().map_err(|error| {
        AppError::Engine(format!("Could not start four-stem separation: {error}"))
    })?;
    if !result.status.success() {
        let message = limited_text(&String::from_utf8_lossy(&result.stderr));
        return Err(AppError::Process(if message.is_empty() {
            format!("Four-stem separation exited with status {}", result.status)
        } else {
            message
        }));
    }
    let files = fs::read_dir(&output)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
        })
        .collect::<Vec<_>>();
    for required in REQUIRED_STEMS {
        if !files.iter().any(|path| {
            path.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .to_ascii_lowercase()
                    .contains(required)
            })
        }) {
            return Err(AppError::Process(format!(
                "Stem separation did not produce the {required} channel"
            )));
        }
    }
    files
        .iter()
        .map(|path| external_path_string(path))
        .collect()
}

fn stem_engine_directory(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("stem-engine"))
        .map_err(|error| {
            AppError::Engine(format!("Could not resolve the stem-engine folder: {error}"))
        })
}

fn separator_path(app: &AppHandle) -> AppResult<PathBuf> {
    let root = stem_engine_directory(app)?;
    let candidate = root.join(r"runtime\Scripts\audio-separator.exe");
    let canonical_root = root.canonicalize().map_err(|_| {
        AppError::Engine(
            "The optional four-stem engine is not installed; set it up in Settings".into(),
        )
    })?;
    let canonical = candidate.canonicalize().map_err(|_| {
        AppError::Engine(
            "The optional four-stem engine is not installed; set it up in Settings".into(),
        )
    })?;
    if !canonical.is_file() || !canonical.starts_with(&canonical_root) {
        return Err(AppError::Engine(
            "The optional four-stem engine is invalid".into(),
        ));
    }
    Ok(canonical)
}

fn unique_output_directory(parent: &Path, base: &str) -> AppResult<PathBuf> {
    for suffix in 0..10_000 {
        let name = if suffix == 0 {
            base.to_string()
        } else {
            format!("{base} ({suffix})")
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(
        "Could not allocate a stem output folder".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_a_new_stem_folder_without_reusing_existing_output() {
        let root = std::env::temp_dir().join(format!("sonic-stems-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("Beat - stems")).unwrap();
        assert_eq!(
            unique_output_directory(&root, "Beat - stems").unwrap(),
            root.join("Beat - stems (1)")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
