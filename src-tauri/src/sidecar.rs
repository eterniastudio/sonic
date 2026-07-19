use std::{fs, io::Write, path::Path, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    error::{invalid, AppResult},
    models::{AudioProperties, ExportSpec, FinalMetadata, SourceInspection, SourceSpec},
};

pub const SIDECAR_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicSidecar {
    pub schema_version: u32,
    pub sonic_version: String,
    pub library_item_id: String,
    pub job_id: String,
    pub client_item_id: Option<String>,
    pub created_at_ms: i64,
    pub source: SidecarSource,
    pub metadata: FinalMetadata,
    pub inspection_audio: AudioProperties,
    pub output_audio: AudioProperties,
    pub export: ExportSpec,
    pub output_sha256: String,
    pub tag_status: TagStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarSource {
    pub kind: String,
    pub source_fingerprint: String,
    pub provider_id: Option<String>,
    pub canonical_url: Option<String>,
    pub file_name: Option<String>,
    pub original_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStatus {
    pub requested: bool,
    pub supported: bool,
    pub readback_verified: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SidecarBuild<'a> {
    pub library_item_id: &'a str,
    pub job_id: &'a str,
    pub client_item_id: Option<&'a str>,
    pub created_at_ms: i64,
    pub inspection: &'a SourceInspection,
    pub metadata: &'a FinalMetadata,
    pub output_audio: &'a AudioProperties,
    pub export: &'a ExportSpec,
    pub output_sha256: &'a str,
    pub include_source_path: bool,
    pub tag_status: TagStatus,
}

pub fn build_sidecar(input: SidecarBuild<'_>) -> SonicSidecar {
    SonicSidecar {
        schema_version: SIDECAR_SCHEMA_VERSION,
        sonic_version: env!("CARGO_PKG_VERSION").to_string(),
        library_item_id: input.library_item_id.to_string(),
        job_id: input.job_id.to_string(),
        client_item_id: input.client_item_id.map(str::to_string),
        created_at_ms: input.created_at_ms,
        source: sidecar_source(
            &input.inspection.source,
            &input.inspection.source_fingerprint,
            input.include_source_path,
        ),
        metadata: input.metadata.clone(),
        inspection_audio: input.inspection.audio.clone(),
        output_audio: input.output_audio.clone(),
        export: input.export.clone(),
        output_sha256: input.output_sha256.to_string(),
        tag_status: input.tag_status,
    }
}

pub fn write_sidecar(workspace: &Path, value: &SonicSidecar) -> AppResult<PathBuf> {
    if !workspace.is_dir() {
        return Err(invalid("The sidecar workspace is unavailable"));
    }
    let path = workspace.join("export.sonic.json");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    if bytes.len() > 512 * 1024 {
        return Err(invalid("The Sonic metadata sidecar is unexpectedly large"));
    }
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(path)
}

pub fn read_sidecar(path: &Path) -> AppResult<SonicSidecar> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Err(invalid("The Sonic metadata sidecar is invalid"));
    }
    let value: SonicSidecar = serde_json::from_slice(&fs::read(path)?)?;
    if value.schema_version != SIDECAR_SCHEMA_VERSION {
        return Err(invalid("The Sonic metadata sidecar version is unsupported"));
    }
    Ok(value)
}

fn sidecar_source(
    source: &SourceSpec,
    source_fingerprint: &str,
    include_source_path: bool,
) -> SidecarSource {
    match source {
        SourceSpec::Youtube { url } => {
            let provider_id = url::Url::parse(url).ok().and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == "v")
                    .map(|(_, value)| value.into_owned())
            });
            SidecarSource {
                kind: "youtube".into(),
                source_fingerprint: source_fingerprint.to_string(),
                provider_id,
                canonical_url: Some(url.clone()),
                file_name: None,
                original_path: None,
            }
        }
        SourceSpec::LocalFile { path } => SidecarSource {
            kind: "localFile".into(),
            source_fingerprint: source_fingerprint.to_string(),
            provider_id: None,
            canonical_url: None,
            file_name: Path::new(path)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned()),
            original_path: include_source_path.then(|| path.clone()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{metadata::MusicMetadata, models::ExportPresetId};

    #[test]
    fn local_sidecars_hide_original_path_by_default() {
        let inspection = SourceInspection {
            id: "local".into(),
            source: SourceSpec::LocalFile {
                path: "C:\\private\\beat.wav".into(),
            },
            source_fingerprint: "sha256:test".into(),
            title: "Beat".into(),
            artist: None,
            description: None,
            thumbnail_url: None,
            webpage_url: None,
            is_live: false,
            audio: AudioProperties {
                container: Some("wav".into()),
                codec: Some("pcm_s24le".into()),
                sample_rate_hz: Some(44_100),
                channels: Some(2),
                bit_depth: Some(24),
                duration_ms: Some(1_000),
                file_size_bytes: Some(10),
            },
            declared_metadata: MusicMetadata::default(),
            embedded_metadata: MusicMetadata::default(),
            suggested_metadata: MusicMetadata::default(),
            warnings: vec![],
        };
        let metadata = FinalMetadata {
            title: "Beat".into(),
            ..Default::default()
        };
        let output = inspection.audio.clone();
        let value = build_sidecar(SidecarBuild {
            library_item_id: "item",
            job_id: "job",
            client_item_id: None,
            created_at_ms: 1,
            inspection: &inspection,
            metadata: &metadata,
            output_audio: &output,
            export: &ExportSpec {
                preset_id: ExportPresetId::Flac,
                ..Default::default()
            },
            output_sha256: "abc",
            include_source_path: false,
            tag_status: TagStatus {
                requested: true,
                supported: true,
                readback_verified: true,
                warnings: vec![],
            },
        });
        assert_eq!(value.source.file_name.as_deref(), Some("beat.wav"));
        assert!(value.source.original_path.is_none());
    }
}
