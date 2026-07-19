use std::{
    fs,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::{
    error::{invalid, AppError, AppResult},
    models::{ExportPresetId, FilenamePreview, FinalMetadata, SourceSpec},
    tools::sha256_file,
};

pub const JOB_DIRECTORY_PREFIX: &str = ".sonic-job-";
const MAX_STEM_CHARACTERS: usize = 150;
const ALLOWED_LOCAL_EXTENSIONS: &[&str] = &[
    "wav", "wave", "mp3", "m4a", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "aif", "aiff",
    "wma",
];

#[derive(Clone, Debug)]
pub struct PublishedPair {
    pub audio_path: PathBuf,
    pub sidecar_path: PathBuf,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationJournal {
    pub job_id: String,
    pub audio_path: String,
    pub sidecar_path: String,
    pub audio_sha256: String,
    pub sidecar_sha256: String,
}

pub fn canonical_output_directory(input: &str) -> AppResult<PathBuf> {
    let input = input.trim();
    let normalized = normalize_windows_filesystem_path(input)
        .ok_or_else(|| invalid("Choose a normal drive or network output folder"))?;
    let path = PathBuf::from(&normalized);
    if input.is_empty() || !path.is_absolute() {
        return Err(invalid("Choose an absolute output folder"));
    }
    fs::create_dir_all(&path).map_err(|error| {
        AppError::InvalidInput(format!("Could not create output folder: {error}"))
    })?;
    let canonical = path.canonicalize().map_err(|error| {
        AppError::InvalidInput(format!("Could not access output folder: {error}"))
    })?;
    if !canonical.is_dir() {
        return Err(invalid("The selected output path is not a folder"));
    }
    Ok(canonical)
}

pub fn canonical_local_audio(input: &str, max_bytes: u64) -> AppResult<PathBuf> {
    let input = input.trim();
    let normalized = normalize_windows_filesystem_path(input)
        .ok_or_else(|| invalid("Choose a supported local audio file"))?;
    if input.is_empty() {
        return Err(invalid("Choose a supported local audio file"));
    }
    let path = PathBuf::from(normalized);
    if !path.is_absolute() {
        return Err(invalid("The local media path must be absolute"));
    }
    let original_metadata = fs::symlink_metadata(&path)
        .map_err(|error| invalid(format!("Could not access the local file: {error}")))?;
    if original_metadata.file_type().is_symlink() || is_reparse_point(&original_metadata) {
        return Err(invalid(
            "Symbolic links and reparse-point media files are not supported",
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| invalid(format!("Could not resolve the local file: {error}")))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| invalid(format!("Could not read the local file: {error}")))?;
    if !metadata.is_file() {
        return Err(invalid("The selected local path is not a regular file"));
    }
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(invalid(format!(
            "The local file must be between 1 byte and {max_bytes} bytes"
        )));
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid("The local file has no supported audio extension"))?;
    if !ALLOWED_LOCAL_EXTENSIONS.contains(&extension.as_str()) {
        return Err(invalid(format!(
            "The .{extension} file type is not supported for local intake"
        )));
    }
    Ok(canonical)
}

/// Converts a canonical filesystem path into the stable form persisted in JSON/SQLite and sent
/// to the renderer. Windows canonicalization adds a `\\?\` namespace prefix; that prefix is an
/// internal API detail and cannot safely be fed back through Sonic's untrusted path boundary.
pub fn external_path_string(path: &Path) -> AppResult<String> {
    normalize_windows_filesystem_path(&path.to_string_lossy())
        .ok_or_else(|| invalid("The filesystem path uses an unsupported Windows device namespace"))
}

pub fn canonical_recorded_file(path: &Path) -> AppResult<Option<PathBuf>> {
    if !path.is_absolute() {
        return Err(invalid("The recorded library path is not absolute"));
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::Io(error)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(invalid(
            "The recorded library file is not a safe regular file",
        ));
    }
    let canonical = path.canonicalize()?;
    if !canonical.is_file() {
        return Err(invalid(
            "The recorded library file is no longer a regular file",
        ));
    }
    Ok(Some(canonical))
}

pub fn prepare_workspace(output_directory: &Path, job_id: &str) -> AppResult<PathBuf> {
    validate_job_id(job_id)?;
    let path = output_directory.join(format!("{JOB_DIRECTORY_PREFIX}{job_id}"));
    if path.exists() {
        return Err(AppError::Conflict(
            "The isolated job workspace already exists".into(),
        ));
    }
    fs::create_dir(&path)?;
    let canonical = match path.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir(&path);
            return Err(AppError::Io(error));
        }
    };
    if canonical.parent() != Some(output_directory) {
        let _ = fs::remove_dir(&canonical);
        return Err(invalid("The isolated workspace escaped the output folder"));
    }
    let metadata = fs::symlink_metadata(&canonical)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        let _ = fs::remove_dir(&canonical);
        return Err(invalid("The isolated workspace was not a safe directory"));
    }
    Ok(canonical)
}

pub fn safe_cleanup_workspace(path: &Path, output_directory: &Path, job_id: &str) -> bool {
    if validate_job_id(job_id).is_err()
        || path.file_name().and_then(|name| name.to_str())
            != Some(format!("{JOB_DIRECTORY_PREFIX}{job_id}").as_str())
    {
        return false;
    }
    let Ok(canonical_output) = output_directory.canonicalize() else {
        return false;
    };
    let Ok(canonical_parent) = path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .canonicalize()
    else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if canonical_parent != canonical_output
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
    {
        return false;
    }
    fs::remove_dir_all(path).is_ok()
}

pub fn render_filename(
    template: &str,
    metadata: &FinalMetadata,
    preset: ExportPresetId,
    original_extension: Option<&str>,
    source: Option<&SourceSpec>,
) -> AppResult<FilenamePreview> {
    let template = template.trim();
    if template.is_empty() || template.chars().count() > 240 {
        return Err(invalid(
            "Filename templates must contain 1 to 240 characters",
        ));
    }
    let mut warnings = Vec::new();
    let mut rendered = String::with_capacity(template.len() + 32);
    let characters = template.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < characters.len() {
        if characters[index] != '{' {
            rendered.push(characters[index]);
            index += 1;
            continue;
        }
        let Some(relative_end) = characters[index + 1..]
            .iter()
            .position(|value| *value == '}')
        else {
            return Err(invalid(
                "Filename template contains an unclosed placeholder",
            ));
        };
        let end = index + relative_end + 1;
        let key = characters[index + 1..end].iter().collect::<String>();
        let value = template_value(&key, metadata, preset, source)?;
        if value.is_empty() {
            warnings.push(format!("{{{key}}} has no value and was omitted"));
        }
        rendered.push_str(&value);
        index = end + 1;
    }
    let stem = sanitize_file_stem(&rendered);
    if stem.is_empty() {
        return Err(invalid("The filename template produced an empty filename"));
    }
    let extension = preset_extension(preset, original_extension)?;
    Ok(FilenamePreview {
        full_name: format!("{stem}.{extension}"),
        stem,
        extension,
        warnings,
    })
}

fn template_value(
    key: &str,
    metadata: &FinalMetadata,
    preset: ExportPresetId,
    source: Option<&SourceSpec>,
) -> AppResult<String> {
    let value = match key {
        "title" => metadata.title.clone(),
        "artist" | "producer" => metadata.artist.clone().unwrap_or_default(),
        "bpm" => metadata.bpm.map(format_number).unwrap_or_default(),
        "key" => metadata.key.clone().unwrap_or_default(),
        "camelot" => metadata.camelot.clone().unwrap_or_default(),
        "detune" => metadata
            .detune_cents
            .map(|value| {
                let value = format_number(value);
                if value.starts_with('-') {
                    format!("{value}c")
                } else {
                    format!("+{value}c")
                }
            })
            .unwrap_or_default(),
        "source" => match source {
            Some(SourceSpec::Youtube { .. }) => "YouTube".to_string(),
            Some(SourceSpec::LocalFile { .. }) => "Local".to_string(),
            None => String::new(),
        },
        "date" => time::OffsetDateTime::now_utc().date().to_string(),
        "preset" => preset_template_label(preset).to_string(),
        _ => return Err(invalid(format!("Unknown filename placeholder: {{{key}}}"))),
    };
    Ok(value)
}

fn preset_template_label(preset: ExportPresetId) -> &'static str {
    match preset {
        ExportPresetId::Original => "original",
        ExportPresetId::Mp3V0 => "mp3-v0",
        ExportPresetId::Mp3Cbr320 => "mp3-320",
        ExportPresetId::M4aAac256 => "m4a-aac-256",
        ExportPresetId::Wav44100S24 => "wav-44.1-24",
        ExportPresetId::Wav48000S24 => "wav-48-24",
        ExportPresetId::Flac => "flac",
        ExportPresetId::Opus192 => "opus-192",
    }
}

pub fn sanitize_file_stem(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len().min(180));
    let mut previous_was_space = false;
    for character in value.chars() {
        if sanitized.chars().count() >= MAX_STEM_CHARACTERS {
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
    let mut sanitized = sanitized.trim_matches([' ', '.', '-']).to_string();
    let reserved = sanitized
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
    if reserved {
        sanitized.insert(0, '_');
    }
    sanitized
}

pub fn preset_extension(
    preset: ExportPresetId,
    original_extension: Option<&str>,
) -> AppResult<String> {
    let extension = match preset {
        ExportPresetId::Original => original_extension
            .map(str::to_ascii_lowercase)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 8
                    && value
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
            .ok_or_else(|| invalid("The original media extension could not be determined"))?,
        ExportPresetId::Mp3V0 | ExportPresetId::Mp3Cbr320 => "mp3".to_string(),
        ExportPresetId::M4aAac256 => "m4a".to_string(),
        ExportPresetId::Wav44100S24 | ExportPresetId::Wav48000S24 => "wav".to_string(),
        ExportPresetId::Flac => "flac".to_string(),
        ExportPresetId::Opus192 => "opus".to_string(),
    };
    Ok(extension)
}

pub fn publish_pair(
    job_id: &str,
    staged_audio: &Path,
    staged_sidecar: &Path,
    workspace: &Path,
    output_directory: &Path,
    requested_stem: &str,
) -> AppResult<PublishedPair> {
    validate_staged_file(staged_audio, workspace)?;
    validate_staged_file(staged_sidecar, workspace)?;
    let extension = staged_audio
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("The completed audio file had no extension"))?;
    let audio_hash = sha256_file(staged_audio)?;
    let sidecar_hash = sha256_file(staged_sidecar)?;
    for suffix in 1..10_000_u32 {
        let stem = if suffix == 1 {
            requested_stem.to_string()
        } else {
            sanitize_file_stem(&format!("{requested_stem} ({suffix})"))
        };
        let audio_destination = output_directory.join(format!("{stem}.{extension}"));
        let sidecar_destination = output_directory.join(format!("{stem}.sonic.json"));
        if audio_destination.exists() || sidecar_destination.exists() {
            continue;
        }
        let journal = PublicationJournal {
            job_id: job_id.to_string(),
            audio_path: external_path_string(&audio_destination)?,
            sidecar_path: external_path_string(&sidecar_destination)?,
            audio_sha256: audio_hash.clone(),
            sidecar_sha256: sidecar_hash.clone(),
        };
        fs::write(
            workspace.join("publication.json"),
            serde_json::to_vec_pretty(&journal)?,
        )?;
        match move_file_no_replace(staged_audio, &audio_destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::Io(error)),
        }
        match move_file_no_replace(staged_sidecar, &sidecar_destination) {
            Ok(()) => {
                let canonical_audio = audio_destination.canonicalize()?;
                let canonical_sidecar = sidecar_destination.canonicalize()?;
                if canonical_audio.parent() != Some(output_directory)
                    || canonical_sidecar.parent() != Some(output_directory)
                {
                    let _ = fs::remove_file(&canonical_audio);
                    let _ = fs::remove_file(&canonical_sidecar);
                    return Err(invalid("The published files escaped the output folder"));
                }
                return Ok(PublishedPair {
                    audio_path: canonical_audio,
                    sidecar_path: canonical_sidecar,
                });
            }
            Err(error) => {
                let rollback = move_file_no_replace(&audio_destination, staged_audio);
                if rollback.is_err() {
                    return Err(AppError::Internal(
                        "Could not safely roll back a partial publication".into(),
                    ));
                }
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(AppError::Io(error));
                }
            }
        }
    }
    Err(AppError::Conflict(
        "Could not choose an unused output filename".into(),
    ))
}

pub fn read_publication_journal(workspace: &Path) -> AppResult<Option<PublicationJournal>> {
    let path = workspace.join("publication.json");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn validate_staged_file(path: &Path, workspace: &Path) -> AppResult<()> {
    let canonical = path.canonicalize()?;
    if !canonical.is_file() || canonical.parent() != Some(workspace) {
        return Err(invalid("A staged output escaped its isolated workspace"));
    }
    let metadata = fs::symlink_metadata(&canonical)?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(invalid("A staged output was an unsafe reparse point"));
    }
    Ok(())
}

fn validate_job_id(job_id: &str) -> AppResult<()> {
    let parsed = Uuid::parse_str(job_id).map_err(|_| invalid("The job ID is invalid"))?;
    if parsed.to_string() != job_id.to_ascii_lowercase() {
        return Err(invalid("The job ID is not canonical"));
    }
    Ok(())
}

fn format_number(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

fn normalize_windows_filesystem_path(value: &str) -> Option<String> {
    let comparable = value.replace('/', "\\").to_ascii_lowercase();
    if comparable.starts_with(r"\\.\") {
        return None;
    }
    if comparable.starts_with(r"\\?\unc\") {
        let network_path = value.get(8..)?;
        return (!network_path.is_empty()).then(|| format!(r"\\{network_path}"));
    }
    if comparable.starts_with(r"\\?\") {
        let disk_path = value.get(4..)?;
        let bytes = disk_path.as_bytes();
        let is_absolute_drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/');
        return is_absolute_drive.then(|| disk_path.to_string());
    }
    Some(value.to_string())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
pub fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
    let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn move_file_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> FinalMetadata {
        FinalMetadata {
            title: "Night Shift".into(),
            artist: Some("Eternia".into()),
            bpm: Some(144.0),
            key: Some("F# minor".into()),
            camelot: Some("11A".into()),
            detune_cents: Some(-32.0),
            ..Default::default()
        }
    }

    #[test]
    fn renders_and_sanitizes_templates() {
        let preview = render_filename(
            "{artist} - {title} [{bpm} {key} {detune}]",
            &metadata(),
            ExportPresetId::Mp3Cbr320,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            preview.full_name,
            "Eternia - Night Shift [144 F# minor -32c].mp3"
        );
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert!(
            render_filename("{unknown}", &metadata(), ExportPresetId::Flac, None, None).is_err()
        );
    }

    #[test]
    fn preset_template_token_uses_stable_filename_labels() {
        let preview = render_filename(
            "{title} - {preset}",
            &metadata(),
            ExportPresetId::Wav44100S24,
            None,
            None,
        )
        .unwrap();
        assert_eq!(preview.full_name, "Night Shift - wav-44.1-24.wav");
    }

    #[test]
    fn normalizes_only_safe_windows_verbatim_paths() {
        assert_eq!(
            normalize_windows_filesystem_path(r"\\?\C:\Users\Producer\Downloads\Sonic"),
            Some(r"C:\Users\Producer\Downloads\Sonic".into())
        );
        assert_eq!(
            normalize_windows_filesystem_path(r"\\?\UNC\studio-nas\beats\Sonic"),
            Some(r"\\studio-nas\beats\Sonic".into())
        );
        assert_eq!(
            normalize_windows_filesystem_path(r"C:\Users\Producer\Downloads\Sonic"),
            Some(r"C:\Users\Producer\Downloads\Sonic".into())
        );
        assert!(normalize_windows_filesystem_path(r"\\.\PhysicalDrive0").is_none());
        assert!(normalize_windows_filesystem_path(
            r"\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1"
        )
        .is_none());
        assert!(normalize_windows_filesystem_path(r"\\?\Volume{1234}\Sonic").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn selected_output_folder_survives_canonical_storage_round_trip() {
        let requested = std::env::temp_dir()
            .join(format!("sonic-output-roundtrip-{}", Uuid::new_v4()))
            .join("Selected downloads");
        let canonical = canonical_output_directory(&requested.to_string_lossy()).unwrap();
        let stored = external_path_string(&canonical).unwrap();

        assert!(Path::new(&stored).is_absolute());
        assert!(!stored.starts_with(r"\\?\"));
        assert_eq!(canonical_output_directory(&stored).unwrap(), canonical);
        assert_eq!(
            canonical_output_directory(&canonical.to_string_lossy()).unwrap(),
            canonical
        );

        fs::remove_dir_all(requested.parent().unwrap()).unwrap();
    }

    #[test]
    fn cleanup_requires_exact_workspace_identity() {
        let root = std::env::temp_dir().join(format!("sonic-fs-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let job_id = Uuid::new_v4().to_string();
        let workspace = prepare_workspace(&root, &job_id).unwrap();
        assert!(!safe_cleanup_workspace(
            &workspace,
            &root,
            &Uuid::new_v4().to_string()
        ));
        assert!(safe_cleanup_workspace(&workspace, &root, &job_id));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn paired_publication_never_clobbers() {
        let root = std::env::temp_dir().join(format!("sonic-publish-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let output = root.canonicalize().unwrap();
        fs::write(output.join("Beat.mp3"), b"keep").unwrap();
        let job_id = Uuid::new_v4().to_string();
        let workspace = prepare_workspace(&output, &job_id).unwrap();
        let audio = workspace.join("export.mp3");
        let sidecar = workspace.join("export.sonic.json");
        fs::write(&audio, b"new").unwrap();
        fs::write(&sidecar, b"{}").unwrap();
        let published =
            publish_pair(&job_id, &audio, &sidecar, &workspace, &output, "Beat").unwrap();
        assert_eq!(fs::read(output.join("Beat.mp3")).unwrap(), b"keep");
        assert_eq!(fs::read(published.audio_path).unwrap(), b"new");
        assert!(safe_cleanup_workspace(&workspace, &output, &job_id));
        fs::remove_dir_all(root).unwrap();
    }
}
