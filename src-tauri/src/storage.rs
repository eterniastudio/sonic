use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    audio_analysis::{apply_to_final_metadata, apply_to_music_metadata, AudioAnalysis},
    error::{conflict, invalid, not_found, AppError, AppResult},
    filesystem::external_path_string,
    models::{
        AppSettings, Collection, EnqueueItem, FacetCount, JobDetail, JobPage, JobProgress,
        JobQuery, JobState, LibraryFacets, LibraryItem, LibraryPage, LibraryQuery, LibraryRoot,
        LibrarySort, QueueJob, QueueSnapshot, SettingsPatch, SettingsSnapshot, SourceSpec, Tag,
    },
};

pub const DB_SCHEMA_VERSION: u32 = 3;
const APPLICATION_ID: i64 = 0x534F_4E49; // "SONI"

#[derive(Clone)]
pub struct Repository {
    connection: Arc<Mutex<Connection>>,
    database_path: PathBuf,
    data_directory: PathBuf,
}

impl Repository {
    pub fn open(app: &AppHandle) -> AppResult<Self> {
        let data_directory = app
            .path()
            .app_local_data_dir()
            .map_err(|error| AppError::Internal(format!("Could not resolve app data: {error}")))?
            .join("data");
        Self::open_at(&data_directory)
    }

    pub fn open_at(data_directory: &Path) -> AppResult<Self> {
        fs::create_dir_all(data_directory)?;
        let data_directory = data_directory.canonicalize()?;
        let database_path = data_directory.join("sonic.sqlite3");
        let connection = Connection::open(&database_path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        let repository = Self {
            connection: Arc::new(Mutex::new(connection)),
            database_path,
            data_directory,
        };
        repository.migrate()?;
        Ok(repository)
    }

    fn migrate(&self) -> AppResult<()> {
        let mut connection = self.lock()?;
        let mut version: u32 =
            connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let existing_database = version > 0;
        if version > DB_SCHEMA_VERSION {
            return Err(AppError::Database(rusqlite::Error::InvalidQuery));
        }
        if version == 0 {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(
                "
                CREATE TABLE schema_migrations (
                  version INTEGER PRIMARY KEY,
                  applied_at_ms INTEGER NOT NULL
                );
                CREATE TABLE app_settings (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  revision INTEGER NOT NULL,
                  json TEXT NOT NULL CHECK (json_valid(json)),
                  updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE queue_state (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  paused INTEGER NOT NULL CHECK (paused IN (0,1)),
                  revision INTEGER NOT NULL,
                  updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE jobs (
                  id TEXT PRIMARY KEY,
                  client_item_id TEXT,
                  state TEXT NOT NULL CHECK (state IN (
                    'queued','preparing','acquiring','copying','transcoding','tagging',
                    'validating','publishing','completed','failed','cancelled','interrupted'
                  )),
                  queue_position INTEGER NOT NULL,
                  revision INTEGER NOT NULL,
                  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
                  progress_json TEXT NOT NULL CHECK (json_valid(progress_json)),
                  working_directory TEXT,
                  output_path TEXT,
                  sidecar_path TEXT,
                  error_code TEXT,
                  error_message TEXT,
                  attempt INTEGER NOT NULL,
                  created_at_ms INTEGER NOT NULL,
                  started_at_ms INTEGER,
                  finished_at_ms INTEGER,
                  updated_at_ms INTEGER NOT NULL
                );
                CREATE INDEX jobs_state_position_idx ON jobs(state, queue_position);
                CREATE INDEX jobs_created_idx ON jobs(created_at_ms DESC);
                CREATE TABLE job_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                  state TEXT NOT NULL,
                  message_code TEXT,
                  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
                  created_at_ms INTEGER NOT NULL
                );
                CREATE INDEX job_events_job_idx ON job_events(job_id, created_at_ms DESC);
                CREATE TABLE library_items (
                  id TEXT PRIMARY KEY,
                  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
                  client_item_id TEXT,
                  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
                  title TEXT NOT NULL,
                  artist TEXT,
                  thumbnail_url TEXT,
                  bpm REAL,
                  alternate_bpms_json TEXT NOT NULL CHECK (json_valid(alternate_bpms_json)),
                  musical_key TEXT,
                  camelot TEXT,
                  detune_cents REAL,
                  tuning_hz REAL,
                  preset_id TEXT NOT NULL,
                  format TEXT NOT NULL,
                  codec TEXT,
                  duration_ms INTEGER,
                  sample_rate_hz INTEGER,
                  channels INTEGER,
                  audio_path TEXT NOT NULL UNIQUE,
                  sidecar_path TEXT NOT NULL,
                  file_size_bytes INTEGER NOT NULL,
                  sha256 TEXT NOT NULL,
                  missing INTEGER NOT NULL CHECK (missing IN (0,1)),
                  created_at_ms INTEGER NOT NULL,
                  updated_at_ms INTEGER NOT NULL
                );
                CREATE INDEX library_created_idx ON library_items(created_at_ms DESC);
                CREATE INDEX library_title_idx ON library_items(title COLLATE NOCASE);
                CREATE INDEX library_artist_idx ON library_items(artist COLLATE NOCASE);
                CREATE INDEX library_key_bpm_idx ON library_items(musical_key, bpm);
                CREATE INDEX library_sha_idx ON library_items(sha256);
                ",
            )?;
            let now = now_ms();
            transaction.execute(
                "INSERT INTO app_settings(id, revision, json, updated_at_ms) VALUES(1, 1, ?1, ?2)",
                params![serde_json::to_string(&AppSettings::default())?, now],
            )?;
            transaction.execute(
                "INSERT INTO queue_state(id, paused, revision, updated_at_ms) VALUES(1, 0, 1, ?1)",
                [now],
            )?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(1, ?1)",
                [now],
            )?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", 1)?;
            transaction.commit()?;
            version = 1;
        } else {
            let application_id: i64 =
                connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
            if application_id != APPLICATION_ID {
                return Err(AppError::Internal(
                    "The local database does not belong to Sonic".into(),
                ));
            }
        }

        if existing_database && version < DB_SCHEMA_VERSION {
            self.backup_database(&connection)?;
        }
        if version < 2 {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(include_str!("migrations/v1_to_v2_columns.sql"))?;
            transaction.execute_batch(include_str!("migrations/v1_to_v2.sql"))?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(2, ?1)",
                [now_ms()],
            )?;
            transaction.pragma_update(None, "user_version", 2)?;
            transaction.commit()?;
            version = 2;
        }
        if version < 3 {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(include_str!("migrations/v2_to_v3.sql"))?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(3, ?1)",
                [now_ms()],
            )?;
            transaction.pragma_update(None, "user_version", 3)?;
            transaction.commit()?;
        }
        Ok(())
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn data_directory(&self) -> &Path {
        &self.data_directory
    }

    pub fn health_check(&self) -> bool {
        self.lock()
            .and_then(|connection| {
                connection
                    .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                    .map_err(AppError::from)
            })
            .is_ok_and(|value| value == "ok")
    }

    pub fn get_settings(&self) -> AppResult<SettingsSnapshot> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT revision, json FROM app_settings WHERE id=1",
                [],
                |row| {
                    let revision = row.get(0)?;
                    let json: String = row.get(1)?;
                    Ok((revision, json))
                },
            )
            .map_err(AppError::from)
            .and_then(|(revision, json)| {
                Ok(SettingsSnapshot {
                    revision,
                    settings: serde_json::from_str(&json)?,
                })
            })
    }

    pub fn update_settings(
        &self,
        patch: SettingsPatch,
        expected_revision: i64,
    ) -> AppResult<SettingsSnapshot> {
        let mut current = self.get_settings()?;
        if current.revision != expected_revision {
            return Err(conflict(
                "Settings changed in another window; refresh and try again",
            ));
        }
        apply_settings_patch(&mut current.settings, patch)?;
        let next_revision = current.revision + 1;
        let changed = self.lock()?.execute(
            "UPDATE app_settings SET revision=?1, json=?2, updated_at_ms=?3 WHERE id=1 AND revision=?4",
            params![
                next_revision,
                serde_json::to_string(&current.settings)?,
                now_ms(),
                expected_revision
            ],
        )?;
        if changed != 1 {
            return Err(conflict(
                "Settings changed in another window; refresh and try again",
            ));
        }
        current.revision = next_revision;
        Ok(current)
    }

    pub fn insert_job(&self, request: &EnqueueItem) -> AppResult<QueueJob> {
        self.insert_jobs(std::slice::from_ref(request))?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Internal("The queue insert returned no job".into()))
    }

    pub fn insert_jobs(&self, requests: &[EnqueueItem]) -> AppResult<Vec<QueueJob>> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(queue_position),0)+1 FROM jobs WHERE state='queued'",
            [],
            |row| row.get(0),
        )?;
        let now = now_ms();
        let mut ids = Vec::with_capacity(requests.len());
        for request in requests {
            let id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO jobs(
                  id,client_item_id,state,queue_position,revision,request_json,progress_json,
                  attempt,created_at_ms,updated_at_ms
                ) VALUES(?1,?2,'queued',?3,1,?4,?5,0,?6,?6)",
                params![
                    id,
                    request.client_item_id,
                    position,
                    serde_json::to_string(request)?,
                    serde_json::to_string(&JobProgress {
                        percent: Some(0.0),
                        message: Some("Queued".into()),
                        ..Default::default()
                    })?,
                    now
                ],
            )?;
            ids.push(id);
            position += 1;
        }
        transaction.execute(
            "UPDATE queue_state SET revision=revision+1,updated_at_ms=?1 WHERE id=1",
            [now],
        )?;
        transaction.commit()?;
        drop(connection);
        ids.iter().map(|id| self.job(id)).collect()
    }

    pub fn job(&self, id: &str) -> AppResult<QueueJob> {
        Ok(self.job_detail(id)?.summary)
    }

    pub fn job_detail(&self, id: &str) -> AppResult<JobDetail> {
        self.lock()?
            .query_row("SELECT * FROM jobs WHERE id=?1", [id], row_to_job_detail)
            .optional()?
            .ok_or_else(|| not_found("The queue job does not exist"))
    }

    pub fn list_jobs(&self, query: &JobQuery) -> AppResult<JobPage> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT * FROM jobs ORDER BY
              CASE WHEN state='queued' THEN 0 ELSE 1 END,
              queue_position ASC, created_at_ms DESC LIMIT 500",
        )?;
        let rows = statement
            .query_map([], row_to_job_detail)?
            .collect::<Result<Vec<_>, _>>()?;
        let states = query.states.iter().copied().collect::<HashSet<_>>();
        let offset = query
            .cursor
            .as_deref()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let limit = query.limit.unwrap_or(50).clamp(1, 100) as usize;
        let filtered = rows
            .into_iter()
            .filter(|item| states.is_empty() || states.contains(&item.summary.state))
            .map(|item| item.summary)
            .collect::<Vec<_>>();
        let items = filtered.iter().skip(offset).take(limit).cloned().collect();
        let next = (offset + limit < filtered.len()).then(|| (offset + limit).to_string());
        Ok(JobPage {
            items,
            next_cursor: next,
        })
    }

    pub fn queue_snapshot(&self) -> AppResult<QueueSnapshot> {
        let (paused, revision): (bool, i64) = self.lock()?.query_row(
            "SELECT paused,revision FROM queue_state WHERE id=1",
            [],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get(1)?)),
        )?;
        let jobs = self
            .list_jobs(&JobQuery {
                limit: Some(100),
                ..Default::default()
            })?
            .items;
        Ok(QueueSnapshot {
            paused,
            revision,
            active_count: jobs.iter().filter(|job| is_running(job.state)).count() as u32,
            queued_count: jobs
                .iter()
                .filter(|job| job.state == JobState::Queued)
                .count() as u32,
            jobs,
        })
    }

    pub fn claim_next_job(&self) -> AppResult<Option<JobDetail>> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let paused: bool =
            transaction.query_row("SELECT paused FROM queue_state WHERE id=1", [], |row| {
                Ok(row.get::<_, i64>(0)? != 0)
            })?;
        if paused {
            transaction.commit()?;
            return Ok(None);
        }
        let id: Option<String> = transaction
            .query_row(
                "SELECT id FROM jobs WHERE state='queued' ORDER BY queue_position,id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            transaction.commit()?;
            return Ok(None);
        };
        let now = now_ms();
        let changed = transaction.execute(
            "UPDATE jobs SET state='preparing',revision=revision+1,started_at_ms=COALESCE(started_at_ms,?1),updated_at_ms=?1 WHERE id=?2 AND state='queued'",
            params![now,id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return Ok(None);
        }
        transaction.execute(
            "UPDATE queue_state SET revision=revision+1,updated_at_ms=?1 WHERE id=1",
            [now],
        )?;
        let detail =
            transaction.query_row("SELECT * FROM jobs WHERE id=?1", [&id], row_to_job_detail)?;
        add_event(&transaction, &id, JobState::Preparing, "claimed", None)?;
        transaction.commit()?;
        Ok(Some(detail))
    }

    pub fn update_job_state(
        &self,
        id: &str,
        state: JobState,
        progress: &JobProgress,
        working_directory: Option<&Path>,
    ) -> AppResult<QueueJob> {
        let changed = self.lock()?.execute(
            "UPDATE jobs SET state=?1,revision=revision+1,progress_json=?2,
             working_directory=COALESCE(?3,working_directory),updated_at_ms=?4
             WHERE id=?5 AND state NOT IN ('completed','failed','cancelled')",
            params![
                state.as_str(),
                serde_json::to_string(progress)?,
                working_directory.map(|value| value.to_string_lossy().into_owned()),
                now_ms(),
                id
            ],
        )?;
        if changed != 1 {
            return Err(conflict("The queue job is no longer active"));
        }
        self.job(id)
    }

    pub fn update_progress(&self, id: &str, progress: &JobProgress) -> AppResult<QueueJob> {
        self.lock()?.execute(
            "UPDATE jobs SET progress_json=?1,updated_at_ms=?2 WHERE id=?3 AND state NOT IN ('completed','failed','cancelled')",
            params![serde_json::to_string(progress)?, now_ms(), id],
        )?;
        self.job(id)
    }

    pub fn complete_job(
        &self,
        id: &str,
        output_path: &Path,
        sidecar_path: &Path,
    ) -> AppResult<QueueJob> {
        let now = now_ms();
        let output_path = external_path_string(output_path)?;
        let sidecar_path = external_path_string(sidecar_path)?;
        let changed = self.lock()?.execute(
            "UPDATE jobs SET state='completed',revision=revision+1,progress_json=?1,
             output_path=?2,sidecar_path=?3,error_code=NULL,error_message=NULL,
             finished_at_ms=?4,updated_at_ms=?4 WHERE id=?5 AND state NOT IN ('cancelled','completed')",
            params![
                serde_json::to_string(&JobProgress {
                    percent: Some(100.0),
                    message: Some("Export complete".into()),
                    ..Default::default()
                })?,
                output_path,
                sidecar_path,
                now,
                id
            ],
        )?;
        if changed != 1 {
            return Err(conflict("The queue job could not be completed"));
        }
        {
            let connection = self.lock()?;
            bump_queue_revision(&connection)?;
        }
        self.job(id)
    }

    pub fn fail_job(&self, id: &str, code: &str, message: &str) -> AppResult<QueueJob> {
        self.finish_job(id, JobState::Failed, code, message)
    }

    pub fn interrupt_job(&self, id: &str, message: &str) -> AppResult<QueueJob> {
        self.finish_job(id, JobState::Interrupted, "interrupted", message)
    }

    pub fn cancel_persisted_job(&self, id: &str) -> AppResult<QueueJob> {
        self.finish_job(
            id,
            JobState::Cancelled,
            "cancelled",
            "Cancelled by the user",
        )
    }

    fn finish_job(
        &self,
        id: &str,
        state: JobState,
        code: &str,
        message: &str,
    ) -> AppResult<QueueJob> {
        let now = now_ms();
        let progress = JobProgress {
            message: Some(message.chars().take(500).collect()),
            ..Default::default()
        };
        let changed = self.lock()?.execute(
            "UPDATE jobs SET state=?1,revision=revision+1,progress_json=?2,error_code=?3,
             error_message=?4,finished_at_ms=?5,updated_at_ms=?5
             WHERE id=?6 AND state NOT IN ('completed','failed','cancelled','interrupted')",
            params![
                state.as_str(),
                serde_json::to_string(&progress)?,
                code,
                message.chars().take(4_000).collect::<String>(),
                now,
                id
            ],
        )?;
        if changed != 1 {
            return Err(conflict("The queue job is already terminal"));
        }
        {
            let connection = self.lock()?;
            bump_queue_revision(&connection)?;
        }
        self.job(id)
    }

    pub fn retry_job_with_cleanup<F>(&self, id: &str, cleanup: F) -> AppResult<QueueJob>
    where
        F: FnOnce(&JobDetail) -> AppResult<()>,
    {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let detail = transaction
            .query_row("SELECT * FROM jobs WHERE id=?1", [id], row_to_job_detail)
            .optional()?
            .ok_or_else(|| not_found("The queue job does not exist"))?;
        if !detail.summary.state.is_terminal() || detail.summary.state == JobState::Completed {
            return Err(conflict(
                "Only failed, interrupted, or cancelled jobs can be retried",
            ));
        }
        cleanup(&detail)?;
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(queue_position),0)+1 FROM jobs WHERE state='queued'",
            [],
            |row| row.get(0),
        )?;
        let changed = transaction.execute(
            "UPDATE jobs SET state='queued',queue_position=?1,revision=revision+1,
             progress_json=?2,working_directory=NULL,output_path=NULL,sidecar_path=NULL,
             error_code=NULL,error_message=NULL,attempt=attempt+1,started_at_ms=NULL,
             finished_at_ms=NULL,updated_at_ms=?3 WHERE id=?4
             AND state IN ('failed','cancelled','interrupted')",
            params![
                position,
                serde_json::to_string(&JobProgress {
                    percent: Some(0.0),
                    message: Some("Queued for retry".into()),
                    ..Default::default()
                })?,
                now_ms(),
                id
            ],
        )?;
        if changed != 1 {
            return Err(conflict("The queue job can no longer be retried"));
        }
        bump_queue_revision(&transaction)?;
        transaction.commit()?;
        drop(connection);
        self.job(id)
    }

    pub fn remove_job_with_cleanup<F>(&self, id: &str, cleanup: F) -> AppResult<bool>
    where
        F: FnOnce(&JobDetail) -> AppResult<()>,
    {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let detail = transaction
            .query_row("SELECT * FROM jobs WHERE id=?1", [id], row_to_job_detail)
            .optional()?
            .ok_or_else(|| not_found("The queue job does not exist"))?;
        if !detail.summary.state.is_terminal() {
            return Err(conflict("Only terminal queue jobs can be removed"));
        }
        let linked_library_item: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_items WHERE job_id=?1)",
            [id],
            |row| row.get(0),
        )?;
        if linked_library_item {
            return Err(conflict(
                "Remove the linked library entry before removing this job",
            ));
        }
        cleanup(&detail)?;
        let changed = transaction.execute(
            "DELETE FROM jobs WHERE id=?1 AND state IN ('completed','failed','cancelled','interrupted')
             AND NOT EXISTS(SELECT 1 FROM library_items WHERE job_id=?1)",
            [id],
        )?;
        if changed != 1 {
            return Err(conflict("The queue job can no longer be removed"));
        }
        bump_queue_revision(&transaction)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn reorder_queue(
        &self,
        ordered_ids: &[String],
        expected_revision: i64,
    ) -> AppResult<QueueSnapshot> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision: i64 =
            transaction.query_row("SELECT revision FROM queue_state WHERE id=1", [], |row| {
                row.get(0)
            })?;
        if revision != expected_revision {
            return Err(conflict("The queue order changed; refresh and try again"));
        }
        let queued = {
            let mut statement = transaction
                .prepare("SELECT id FROM jobs WHERE state='queued' ORDER BY queue_position,id")?;
            let values = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            values
        };
        if queued.len() != ordered_ids.len()
            || queued.iter().collect::<HashSet<_>>() != ordered_ids.iter().collect::<HashSet<_>>()
        {
            return Err(conflict(
                "The reordered IDs must exactly match all queued jobs",
            ));
        }
        for (position, id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE jobs SET queue_position=?1,revision=revision+1,updated_at_ms=?2 WHERE id=?3 AND state='queued'",
                params![position as i64 + 1, now_ms(), id],
            )?;
        }
        transaction.execute(
            "UPDATE queue_state SET revision=revision+1,updated_at_ms=?1 WHERE id=1",
            [now_ms()],
        )?;
        transaction.commit()?;
        drop(connection);
        self.queue_snapshot()
    }

    pub fn set_queue_paused(
        &self,
        paused: bool,
        expected_revision: i64,
    ) -> AppResult<QueueSnapshot> {
        let changed = self.lock()?.execute(
            "UPDATE queue_state SET paused=?1,revision=revision+1,updated_at_ms=?2 WHERE id=1 AND revision=?3",
            params![paused, now_ms(), expected_revision],
        )?;
        if changed != 1 {
            return Err(conflict("The queue changed; refresh and try again"));
        }
        self.queue_snapshot()
    }

    pub fn update_queued_job(
        &self,
        id: &str,
        request: &EnqueueItem,
        expected_revision: i64,
    ) -> AppResult<QueueJob> {
        let changed = self.lock()?.execute(
            "UPDATE jobs SET request_json=?1,client_item_id=?2,revision=revision+1,updated_at_ms=?3
             WHERE id=?4 AND state='queued' AND revision=?5",
            params![
                serde_json::to_string(request)?,
                request.client_item_id,
                now_ms(),
                id,
                expected_revision
            ],
        )?;
        if changed != 1 {
            return Err(conflict("The queued job changed or already started"));
        }
        self.job(id)
    }

    pub fn apply_audio_analysis(
        &self,
        id: &str,
        expected_revision: i64,
        analysis: &AudioAnalysis,
    ) -> AppResult<JobDetail> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request_json: String = transaction
            .query_row(
                "SELECT request_json FROM jobs WHERE id=?1 AND revision=?2
                 AND state NOT IN ('completed','failed','cancelled','interrupted')",
                params![id, expected_revision],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| conflict("The job changed before tempo analysis could be applied"))?;
        let mut request: EnqueueItem = serde_json::from_str(&request_json)?;
        request.inspection.audio_analysis = Some(analysis.clone());
        apply_to_music_metadata(&mut request.inspection.suggested_metadata, analysis);
        apply_to_final_metadata(&mut request.metadata, analysis);
        let changed = transaction.execute(
            "UPDATE jobs SET request_json=?1,revision=revision+1,updated_at_ms=?2
             WHERE id=?3 AND revision=?4",
            params![
                serde_json::to_string(&request)?,
                now_ms(),
                id,
                expected_revision
            ],
        )?;
        if changed != 1 {
            return Err(conflict(
                "The job changed before tempo analysis could be applied",
            ));
        }
        let detail =
            transaction.query_row("SELECT * FROM jobs WHERE id=?1", [id], row_to_job_detail)?;
        transaction.commit()?;
        Ok(detail)
    }

    pub fn running_jobs_for_recovery(&self) -> AppResult<Vec<JobDetail>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT * FROM jobs WHERE state NOT IN ('queued','completed','failed','cancelled','interrupted')",
        )?;
        let values = statement
            .query_map([], row_to_job_detail)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }

    pub fn insert_library_item(&self, item: &LibraryItem) -> AppResult<()> {
        self.lock()?.execute(
            "INSERT INTO library_items(
              id,job_id,client_item_id,source_json,title,artist,thumbnail_url,bpm,
              alternate_bpms_json,musical_key,camelot,detune_cents,tuning_hz,preset_id,
              format,codec,duration_ms,sample_rate_hz,channels,audio_path,sidecar_path,
              file_size_bytes,sha256,missing,created_at_ms,updated_at_ms
            ) VALUES(
              ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
              ?19,?20,?21,?22,?23,?24,?25,?26
            )
            ON CONFLICT(id) DO UPDATE SET
              audio_path=excluded.audio_path,sidecar_path=excluded.sidecar_path,
              file_size_bytes=excluded.file_size_bytes,sha256=excluded.sha256,missing=excluded.missing,
              updated_at_ms=excluded.updated_at_ms",
            params![
                item.id,
                item.job_id,
                item.client_item_id,
                serde_json::to_string(&item.source)?,
                item.title,
                item.artist,
                item.thumbnail_url,
                item.bpm,
                serde_json::to_string(&item.alternate_bpms)?,
                item.key,
                item.camelot,
                item.detune_cents,
                item.tuning_hz,
                serde_json::to_string(&item.preset_id)?,
                item.format,
                item.codec,
                item.duration_ms.map(saturating_i64),
                item.sample_rate_hz,
                item.channels,
                item.audio_path,
                item.sidecar_path,
                saturating_i64(item.file_size_bytes),
                item.sha256,
                item.missing,
                item.created_at_ms,
                item.updated_at_ms
            ],
        )?;
        Ok(())
    }

    pub fn insert_audio_analysis(&self, item_id: &str, analysis: &AudioAnalysis) -> AppResult<()> {
        let tempo = analysis.bpm.as_ref();
        let key = analysis.key.as_ref();
        self.lock()?.execute(
            "INSERT INTO audio_analysis(
               id,item_id,source_sha256,analyzer_version,analyzed_at_ms,bpm_primary,
               bpm_alternates_json,bpm_confidence,key_primary,key_camelot,key_confidence,created_at_ms
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?5)
             ON CONFLICT(item_id) DO UPDATE SET
               source_sha256=excluded.source_sha256,
               analyzer_version=excluded.analyzer_version,
               analyzed_at_ms=excluded.analyzed_at_ms,
               bpm_primary=excluded.bpm_primary,
               bpm_alternates_json=excluded.bpm_alternates_json,
               bpm_confidence=excluded.bpm_confidence,
               key_primary=excluded.key_primary,
               key_camelot=excluded.key_camelot,
               key_confidence=excluded.key_confidence",
            params![
                Uuid::new_v4().to_string(),
                item_id,
                analysis.source_sha256,
                analysis.analyzer_version,
                now_ms(),
                tempo.map(|value| value.primary),
                tempo
                    .map(|value| serde_json::to_string(&value.alternates))
                    .transpose()?,
                tempo.map(|value| value.confidence),
                key.map(|value| value.primary.as_str()),
                key.map(|value| value.camelot.as_str()),
                key.map(|value| value.confidence),
            ],
        )?;
        Ok(())
    }

    pub fn library_item(&self, id: &str) -> AppResult<LibraryItem> {
        let mut item = self
            .lock()?
            .query_row(
                "SELECT * FROM library_items WHERE id=?1",
                [id],
                row_to_library_item,
            )
            .optional()?
            .ok_or_else(|| not_found("The library item does not exist"))?;
        item.missing = !Path::new(&item.audio_path).is_file();
        Ok(item)
    }

    pub fn list_library(&self, query: &LibraryQuery) -> AppResult<LibraryPage> {
        let connection = self.lock()?;

        let mut where_clauses = Vec::<String>::new();
        let mut values = Vec::<rusqlite::types::Value>::new();

        if let Some(search) = query.search.as_deref().filter(|s| !s.trim().is_empty()) {
            let search_pattern = format!("%{}%", search.trim());
            where_clauses.push("(title LIKE ? OR artist LIKE ? OR audio_path LIKE ? OR musical_key LIKE ? OR camelot LIKE ?)".into());
            values.extend((0..5).map(|_| rusqlite::types::Value::Text(search_pattern.clone())));
        }

        if let Some(key) = query.key.as_deref().filter(|k| !k.is_empty()) {
            where_clauses.push("UPPER(musical_key) = UPPER(?)".into());
            values.push(key.to_string().into());
        }

        if let Some(bpm_min) = query.bpm_min {
            where_clauses.push("bpm >= ?".into());
            values.push(bpm_min.into());
        }

        if let Some(bpm_max) = query.bpm_max {
            where_clauses.push("bpm <= ?".into());
            values.push(bpm_max.into());
        }

        if let Some(format) = query.format.as_deref().filter(|f| !f.is_empty()) {
            where_clauses.push("UPPER(format) = UPPER(?)".into());
            values.push(format.to_string().into());
        }

        if let Some(missing) = query.missing {
            where_clauses.push("missing = ?".into());
            values.push((if missing { 1_i64 } else { 0_i64 }).into());
        }

        if let Some(collection_id) = query.collection_id.as_deref().filter(|c| !c.is_empty()) {
            where_clauses.push(
                "id IN (SELECT item_id FROM collection_items WHERE collection_id = ?)".into(),
            );
            values.push(collection_id.to_string().into());
        }

        // AND semantics: an item must carry every selected tag.
        for tag_id in &query.tag_ids {
            if tag_id.is_empty() {
                continue;
            }
            where_clauses
                .push("id IN (SELECT item_id FROM library_item_tags WHERE tag_id = ?)".into());
            values.push(tag_id.clone().into());
        }

        let filtered_where_sql = where_clause(&where_clauses);
        let count_sql = format!("SELECT COUNT(*) FROM library_items {filtered_where_sql}");
        let total_count = connection
            .query_row(
                &count_sql,
                rusqlite::params_from_iter(values.iter()),
                |row| row.get::<_, i64>(0),
            )?
            .max(0) as u64;

        if matches!(query.sort, LibrarySort::Newest | LibrarySort::Oldest) {
            if let Some((created_at, id)) = query
                .cursor
                .as_deref()
                .and_then(|cursor| cursor.split_once(':'))
                .and_then(|(timestamp, id)| timestamp.parse::<i64>().ok().map(|value| (value, id)))
            {
                let comparison = if query.sort == LibrarySort::Newest {
                    "<"
                } else {
                    ">"
                };
                where_clauses.push(format!(
                    "(created_at_ms {comparison} ? OR (created_at_ms = ? AND id {comparison} ?))"
                ));
                values.push(created_at.into());
                values.push(created_at.into());
                values.push(id.to_string().into());
            }
        }

        let limit = query.limit.unwrap_or(50).clamp(1, 100) as i64;
        let sql = format!(
            "SELECT * FROM library_items {} ORDER BY {} LIMIT ?",
            where_clause(&where_clauses),
            query.sort.sql_order(),
        );

        values.push(limit.into());
        let mut statement = connection.prepare(&sql)?;
        let items = statement
            .query_map(
                rusqlite::params_from_iter(values.iter()),
                row_to_library_item,
            )?
            .collect::<Result<Vec<_>, _>>()?;

        let next_cursor = if items.len() == limit as usize {
            items
                .last()
                .map(|item| format!("{}:{}", item.created_at_ms, item.id))
        } else {
            None
        };
        let items = items
            .into_iter()
            .map(|mut item| {
                item.missing = !Path::new(&item.audio_path).is_file();
                item
            })
            .collect::<Vec<_>>();

        let missing_count = connection
            .query_row(
                "SELECT COUNT(*) FROM library_items WHERE missing = 1",
                [],
                |row| row.get::<_, i64>(0),
            )?
            .max(0) as u64;
        let mut facets = LibraryFacets {
            missing_count,
            ..Default::default()
        };

        let mut fmt_stmt = connection.prepare(
            "SELECT format, COUNT(*) as cnt FROM library_items GROUP BY format ORDER BY cnt DESC",
        )?;
        facets.formats = fmt_stmt
            .query_map([], |row| {
                Ok(FacetCount {
                    value: row.get::<_, String>(0)?,
                    count: row.get::<_, i64>(1)?.max(0) as u64,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut key_stmt = connection.prepare(
            "SELECT musical_key, COUNT(*) as cnt FROM library_items WHERE musical_key IS NOT NULL GROUP BY musical_key ORDER BY cnt DESC LIMIT 20",
        )?;
        facets.keys = key_stmt
            .query_map([], |row| {
                Ok(FacetCount {
                    value: row.get::<_, String>(0)?,
                    count: row.get::<_, i64>(1)?.max(0) as u64,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(LibraryPage {
            items,
            next_cursor,
            total_count,
            facets,
        })
    }

    pub fn recent_library(&self, limit: u32) -> AppResult<Vec<LibraryItem>> {
        self.list_library(&LibraryQuery {
            limit: Some(limit.clamp(1, 100)),
            ..Default::default()
        })
        .map(|page| page.items)
    }

    pub fn remove_library_item(&self, id: &str) -> AppResult<bool> {
        let changed = self
            .lock()?
            .execute("DELETE FROM library_items WHERE id=?1", [id])?;
        if changed == 0 {
            return Err(not_found("The library item does not exist"));
        }
        Ok(true)
    }

    pub fn library_count(&self) -> AppResult<u64> {
        let count: i64 =
            self.lock()?
                .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))?;
        Ok(count.max(0) as u64)
    }

    // ==================== Database Backup ====================

    pub fn backup_database(&self, conn: &Connection) -> AppResult<PathBuf> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AppError::Internal("System time error".into()))?
            .as_millis() as i64;

        let backup_filename = format!("sonic_backup_{}.sqlite3", timestamp);
        let backup_path = self.data_directory.join(backup_filename);

        conn.backup("main", &backup_path, None)?;

        Ok(backup_path)
    }

    // ==================== Library Roots ====================

    pub fn create_library_root(&self, label: &str, root_path: &str) -> AppResult<String> {
        let conn = self.lock()?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();

        conn.execute(
            "INSERT INTO library_roots(id, label, root_path, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![id, label, root_path, now, now],
        )?;

        Ok(id)
    }

    pub fn list_library_roots(&self) -> AppResult<Vec<LibraryRoot>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT * FROM library_roots ORDER BY created_at_ms ASC")?;
        let roots = stmt
            .query_map([], |row| {
                Ok(LibraryRoot {
                    id: row.get("id")?,
                    label: row.get("label")?,
                    root_path: row.get("root_path")?,
                    created_at_ms: row.get("created_at_ms")?,
                    updated_at_ms: row.get("updated_at_ms")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(roots)
    }

    pub fn update_library_root(
        &self,
        id: &str,
        label: Option<&str>,
        root_path: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.lock()?;
        let now = now_ms();

        if label.is_none() && root_path.is_none() {
            return Ok(());
        }

        match (label, root_path) {
            (Some(l), Some(p)) => {
                conn.execute(
                    "UPDATE library_roots SET label=?1, root_path=?2, updated_at_ms=?3 WHERE id=?4",
                    params![l, p, now, id],
                )?;
            }
            (Some(l), None) => {
                conn.execute(
                    "UPDATE library_roots SET label=?1, updated_at_ms=?2 WHERE id=?3",
                    params![l, now, id],
                )?;
            }
            (None, Some(p)) => {
                conn.execute(
                    "UPDATE library_roots SET root_path=?1, updated_at_ms=?2 WHERE id=?3",
                    params![p, now, id],
                )?;
            }
            (None, None) => {}
        }

        Ok(())
    }

    pub fn delete_library_root(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;

        // Check if any items reference this root
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM library_items WHERE root_id=?1",
            [id],
            |row| row.get(0),
        )?;

        if count > 0 {
            return Err(AppError::Internal(
                "Cannot delete root with existing library items".into(),
            ));
        }

        conn.execute("DELETE FROM library_roots WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn relink_library_root(&self, id: &str, new_root_path: &str) -> AppResult<usize> {
        let conn = self.lock()?;
        let now = now_ms();

        // Update the root path
        conn.execute(
            "UPDATE library_roots SET root_path=?1, updated_at_ms=?2 WHERE id=?3",
            params![new_root_path, now, id],
        )?;

        // Update all items referencing this root to mark them for re-validation
        let affected = conn.execute(
            "UPDATE library_items SET missing=0, updated_at_ms=?1 WHERE root_id=?2",
            params![now, id],
        )?;

        Ok(affected)
    }

    // ==================== Tags ====================

    pub fn create_tag(&self, name: &str, color: Option<&str>) -> AppResult<String> {
        let conn = self.lock()?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();

        conn.execute(
            "INSERT INTO tags(id, name, color, created_at_ms) VALUES(?1, ?2, ?3, ?4)",
            params![id, name, color, now],
        )?;

        Ok(id)
    }

    pub fn list_tags(&self) -> AppResult<Vec<(Tag, u64)>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT t.*, COUNT(lit.tag_id) as usage_count 
             FROM tags t 
             LEFT JOIN library_item_tags lit ON t.id = lit.tag_id 
             GROUP BY t.id 
             ORDER BY t.name COLLATE NOCASE ASC",
        )?;

        let tags = stmt
            .query_map([], |row| {
                Ok((
                    Tag {
                        id: row.get("id")?,
                        name: row.get("name")?,
                        color: row.get("color")?,
                        created_at_ms: row.get("created_at_ms")?,
                    },
                    row.get::<_, i64>("usage_count")?.max(0) as u64,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    pub fn update_tag(&self, id: &str, name: Option<&str>, color: Option<&str>) -> AppResult<()> {
        let conn = self.lock()?;

        if name.is_none() && color.is_none() {
            return Ok(());
        }

        match (name, color) {
            (Some(n), Some(c)) => {
                conn.execute(
                    "UPDATE tags SET name=?1, color=?2 WHERE id=?3",
                    params![n, c, id],
                )?;
            }
            (Some(n), None) => {
                conn.execute("UPDATE tags SET name=?1 WHERE id=?2", params![n, id])?;
            }
            (None, Some(c)) => {
                conn.execute("UPDATE tags SET color=?1 WHERE id=?2", params![c, id])?;
            }
            (None, None) => {}
        }

        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM tags WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn assign_tag_to_item(&self, item_id: &str, tag_id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        let now = now_ms();

        conn.execute(
            "INSERT OR IGNORE INTO library_item_tags(item_id, tag_id, created_at_ms) VALUES(?1, ?2, ?3)",
            params![item_id, tag_id, now],
        )?;

        Ok(())
    }

    pub fn remove_tag_from_item(&self, item_id: &str, tag_id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute(
            "DELETE FROM library_item_tags WHERE item_id=?1 AND tag_id=?2",
            params![item_id, tag_id],
        )?;
        Ok(())
    }

    pub fn get_item_tags(&self, item_id: &str) -> AppResult<Vec<Tag>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT t.* FROM tags t 
             JOIN library_item_tags lit ON t.id = lit.tag_id 
             WHERE lit.item_id = ?1 
             ORDER BY t.name COLLATE NOCASE ASC",
        )?;

        let tags = stmt
            .query_map([item_id], |row| {
                Ok(Tag {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    color: row.get("color")?,
                    created_at_ms: row.get("created_at_ms")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    // ==================== Collections ====================

    pub fn create_collection(
        &self,
        name: &str,
        description: Option<&str>,
        is_smart: bool,
        query_json: Option<&str>,
    ) -> AppResult<String> {
        let conn = self.lock()?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();

        conn.execute(
            "INSERT INTO collections(id, name, description, is_smart, query_json, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, description, if is_smart { 1i64 } else { 0i64 }, query_json, now],
        )?;

        Ok(id)
    }

    pub fn list_collections(&self) -> AppResult<Vec<(Collection, u64)>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT c.*, COUNT(ci.item_id) as item_count 
             FROM collections c 
             LEFT JOIN collection_items ci ON c.id = ci.collection_id 
             GROUP BY c.id 
             ORDER BY c.created_at_ms DESC",
        )?;

        let collections = stmt
            .query_map([], |row| {
                Ok((
                    Collection {
                        id: row.get("id")?,
                        name: row.get("name")?,
                        description: row.get("description")?,
                        is_smart: row.get::<_, i64>("is_smart")? != 0,
                        query_json: row.get("query_json")?,
                        created_at_ms: row.get("created_at_ms")?,
                        updated_at_ms: row.get("updated_at_ms")?,
                    },
                    row.get::<_, i64>("item_count")?.max(0) as u64,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(collections)
    }

    pub fn update_collection(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        is_smart: Option<bool>,
        query_json: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.lock()?;
        let now = now_ms();

        if name.is_none() && description.is_none() && is_smart.is_none() && query_json.is_none() {
            return Ok(());
        }

        let mut updates = Vec::new();
        let mut values = Vec::<rusqlite::types::Value>::new();

        if let Some(n) = name {
            updates.push("name=?");
            values.push(n.to_string().into());
        }
        if let Some(d) = description {
            updates.push("description=?");
            values.push(d.to_string().into());
        }
        if let Some(s) = is_smart {
            updates.push("is_smart=?");
            values.push((if s { 1_i64 } else { 0_i64 }).into());
        }
        if let Some(q) = query_json {
            updates.push("query_json=?");
            values.push(q.to_string().into());
        }

        updates.push("updated_at_ms=?");
        values.push(now.into());
        values.push(id.to_string().into());

        let sql = format!("UPDATE collections SET {} WHERE id=?", updates.join(","));
        conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;

        Ok(())
    }

    pub fn delete_collection(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM collections WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn add_items_to_collection(
        &self,
        collection_id: &str,
        item_ids: &[&str],
    ) -> AppResult<usize> {
        let conn = self.lock()?;
        let now = now_ms();
        let mut count = 0;

        for item_id in item_ids {
            let affected = conn.execute(
                "INSERT OR IGNORE INTO collection_items(collection_id, item_id, position, created_at_ms) VALUES(?1, ?2, ?3, ?4)",
                params![collection_id, item_id, count as i64, now],
            )?;
            count += affected;
        }

        Ok(count)
    }

    pub fn remove_items_from_collection(
        &self,
        collection_id: &str,
        item_ids: &[&str],
    ) -> AppResult<usize> {
        let conn = self.lock()?;
        let mut total_removed = 0;

        for item_id in item_ids {
            let affected = conn.execute(
                "DELETE FROM collection_items WHERE collection_id=?1 AND item_id=?2",
                params![collection_id, item_id],
            )?;
            total_removed += affected;
        }

        Ok(total_removed)
    }

    pub fn list_collection_items(&self, collection_id: &str) -> AppResult<Vec<String>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT item_id FROM collection_items WHERE collection_id=?1 ORDER BY position, created_at_ms",
        )?;
        let items = stmt
            .query_map(params![collection_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    // ==================== Bulk Operations ====================

    pub fn bulk_tag_items(&self, item_ids: &[&str], tag_ids: &[&str]) -> AppResult<usize> {
        let conn = self.lock()?;
        let now = now_ms();
        let mut count = 0;

        for item_id in item_ids {
            for tag_id in tag_ids {
                let affected = conn.execute(
                    "INSERT OR IGNORE INTO library_item_tags(item_id, tag_id, created_at_ms) VALUES(?1, ?2, ?3)",
                    params![item_id, tag_id, now],
                )?;
                count += affected;
            }
        }

        Ok(count)
    }

    pub fn bulk_update_items(
        &self,
        item_ids: &[&str],
        updates: &crate::models::BulkUpdateRequest,
    ) -> AppResult<usize> {
        let conn = self.lock()?;
        let now = now_ms();
        let mut total_updated = 0;

        for item_id in item_ids {
            let mut updates_vec = Vec::new();
            let mut values = Vec::<rusqlite::types::Value>::new();

            if let Some(ref title) = updates.title {
                updates_vec.push("title=?");
                values.push(title.clone().into());
            }
            if let Some(ref artist) = updates.artist {
                updates_vec.push("artist=?");
                values.push(artist.clone().into());
            }
            if let Some(bpm) = updates.bpm {
                updates_vec.push("bpm=?");
                values.push(bpm.into());
            }
            if let Some(ref key) = updates.key {
                updates_vec.push("musical_key=?");
                values.push(key.clone().into());
            }
            if let Some(ref camelot) = updates.camelot {
                updates_vec.push("camelot=?");
                values.push(camelot.clone().into());
            }
            if let Some(rating) = updates.rating {
                updates_vec.push("rating=?");
                values.push(rating.into());
            }
            if let Some(is_favorite) = updates.is_favorite {
                updates_vec.push("is_favorite=?");
                values.push((if is_favorite { 1_i64 } else { 0_i64 }).into());
            }
            if let Some(ref status) = updates.status {
                updates_vec.push("status=?");
                values.push(status.clone().into());
            }
            if let Some(ref color_label) = updates.color_label {
                updates_vec.push("color_label=?");
                values.push(color_label.clone().into());
            }

            if updates_vec.is_empty() {
                continue;
            }

            updates_vec.push("updated_at_ms=?");
            values.push(now.into());
            values.push((*item_id).to_string().into());

            let sql = format!(
                "UPDATE library_items SET {} WHERE id=?",
                updates_vec.join(",")
            );
            let affected = conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
            total_updated += affected;
        }

        Ok(total_updated)
    }

    pub fn bulk_delete_items(&self, item_ids: &[&str]) -> AppResult<usize> {
        let conn = self.lock()?;
        let mut total_deleted = 0;

        for item_id in item_ids {
            let affected = conn.execute("DELETE FROM library_items WHERE id=?1", [item_id])?;
            total_deleted += affected;
        }

        Ok(total_deleted)
    }

    // ==================== Duplicate Detection ====================

    pub fn find_duplicates_by_sha256(&self) -> AppResult<Vec<crate::models::DuplicateGroup>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT sha256, GROUP_CONCAT(id) as item_ids, COUNT(*) as cnt 
             FROM library_items 
             GROUP BY sha256 
             HAVING COUNT(*) > 1 
             ORDER BY cnt DESC",
        )?;

        let groups = stmt
            .query_map([], |row| {
                let sha256: String = row.get("sha256")?;
                let item_ids_str: String = row.get("item_ids")?;
                let count: i64 = row.get("cnt")?;

                let item_ids: Vec<String> =
                    item_ids_str.split(',').map(|s| s.to_string()).collect();

                Ok(crate::models::DuplicateGroup {
                    group_type: "exact_sha256".to_string(),
                    fingerprint: sha256,
                    item_ids,
                    count: count as u64,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;

        Ok(groups)
    }

    pub fn find_duplicates_by_source_fingerprint(
        &self,
    ) -> AppResult<Vec<crate::models::DuplicateGroup>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT source_json as fp, GROUP_CONCAT(id) as item_ids, COUNT(*) as cnt
             FROM library_items
             WHERE source_json IS NOT NULL AND source_json <> ''
             GROUP BY source_json
             HAVING COUNT(*) > 1 
             ORDER BY cnt DESC",
        )?;

        let groups = stmt
            .query_map([], |row| {
                let fp: Option<String> = row.get("fp")?;
                let item_ids_str: String = row.get("item_ids")?;
                let count: i64 = row.get("cnt")?;

                let item_ids: Vec<String> =
                    item_ids_str.split(',').map(|s| s.to_string()).collect();

                Ok(crate::models::DuplicateGroup {
                    group_type: "same_source".to_string(),
                    fingerprint: fp.unwrap_or_default(),
                    item_ids,
                    count: count as u64,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;

        Ok(groups)
    }

    // ==================== Sidecar Import ====================

    pub fn scan_sidecar_folder(
        &self,
        folder_path: &str,
        recursive: bool,
    ) -> AppResult<crate::models::SidecarImportReport> {
        let folder = Path::new(folder_path);
        if !folder.is_dir() {
            return Err(invalid("The sidecar folder does not exist"));
        }

        let mut report = crate::models::SidecarImportReport {
            scanned_count: 0,
            imported_count: 0,
            skipped_count: 0,
            error_count: 0,
            errors: Vec::new(),
        };

        let is_sidecar = |path: &Path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".sonic.json"))
        };
        let sidecar_files = if recursive {
            walkdir::WalkDir::new(folder)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .map(|entry| entry.into_path())
                .filter(|path| is_sidecar(path))
                .collect::<Vec<_>>()
        } else {
            fs::read_dir(folder)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| is_sidecar(path))
                .collect::<Vec<_>>()
        };

        report.scanned_count = sidecar_files.len() as u64;
        for sidecar_path in sidecar_files {
            match self.import_sidecar_file(&sidecar_path) {
                Ok(true) => report.imported_count += 1,
                Ok(false) => report.skipped_count += 1,
                Err(error) => {
                    report.error_count += 1;
                    report.errors.push(crate::models::SidecarImportError {
                        path: sidecar_path.to_string_lossy().into_owned(),
                        error: error.public_message(),
                        error_code: "import_failed".into(),
                    });
                }
            }
        }

        Ok(report)
    }

    fn import_sidecar_file(&self, sidecar_path: &Path) -> AppResult<bool> {
        let sidecar = crate::sidecar::read_sidecar(sidecar_path)?;
        let audio_path = crate::filesystem::audio_path_for_sidecar(sidecar_path)?;
        if !audio_path.is_file() {
            return Err(invalid("The sidecar audio file is missing"));
        }
        if crate::tools::sha256_file(&audio_path)? != sidecar.output_sha256 {
            return Err(invalid("The sidecar audio hash does not match"));
        }

        let exists = self.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_items WHERE id=?1)",
            [&sidecar.library_item_id],
            |row| row.get::<_, bool>(0),
        )?;
        if exists {
            return Ok(false);
        }

        let source = match sidecar.source.kind.as_str() {
            "youtube" => SourceSpec::Youtube {
                url: sidecar.source.canonical_url.clone().unwrap_or_default(),
            },
            "soundcloud" => SourceSpec::Soundcloud {
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
        };
        let import_request = EnqueueItem {
            client_item_id: sidecar.client_item_id.clone(),
            source: source.clone(),
            expected_fingerprint: Some(sidecar.source.source_fingerprint.clone()),
            inspection: crate::models::SourceInspection {
                id: format!("sidecar:{}", sidecar.library_item_id),
                source: source.clone(),
                source_fingerprint: sidecar.source.source_fingerprint.clone(),
                title: sidecar.metadata.title.clone(),
                artist: sidecar.metadata.artist.clone(),
                description: None,
                thumbnail_url: None,
                webpage_url: sidecar.source.canonical_url.clone(),
                is_live: false,
                audio: sidecar.inspection_audio.clone(),
                declared_metadata: crate::metadata::MusicMetadata::default(),
                embedded_metadata: crate::metadata::MusicMetadata::default(),
                suggested_metadata: crate::metadata::MusicMetadata::default(),
                audio_analysis: sidecar.audio_analysis.clone(),
                warnings: vec![],
            },
            metadata: sidecar.metadata.clone(),
            export: sidecar.export.clone(),
            output_directory: audio_path
                .parent()
                .map(external_path_string)
                .transpose()?
                .unwrap_or_default(),
            filename_template: "{title}".into(),
        };
        let inserted_job = self.lock()?.execute(
            "INSERT OR IGNORE INTO jobs(
              id,client_item_id,state,queue_position,revision,request_json,progress_json,
              attempt,created_at_ms,finished_at_ms,updated_at_ms
            ) VALUES(?1,?2,'completed',0,1,?3,'{}',0,?4,?4,?4)",
            params![
                sidecar.job_id,
                sidecar.client_item_id,
                serde_json::to_string(&import_request)?,
                sidecar.created_at_ms,
            ],
        )?;
        let audio_metadata = fs::metadata(&audio_path)?;
        let item = LibraryItem {
            id: sidecar.library_item_id,
            job_id: sidecar.job_id,
            client_item_id: sidecar.client_item_id,
            source,
            title: sidecar.metadata.title,
            artist: sidecar.metadata.artist,
            thumbnail_url: None,
            bpm: sidecar.metadata.bpm,
            alternate_bpms: sidecar.metadata.alternate_bpms,
            key: sidecar.metadata.key,
            camelot: sidecar.metadata.camelot,
            detune_cents: sidecar.metadata.detune_cents,
            tuning_hz: sidecar.metadata.tuning_hz,
            preset_id: sidecar.export.preset_id,
            format: sidecar
                .output_audio
                .container
                .clone()
                .or_else(|| {
                    audio_path
                        .extension()
                        .map(|value| value.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| "audio".into()),
            codec: sidecar.output_audio.codec,
            duration_ms: sidecar.output_audio.duration_ms,
            sample_rate_hz: sidecar.output_audio.sample_rate_hz,
            channels: sidecar.output_audio.channels,
            audio_path: external_path_string(&audio_path)?,
            sidecar_path: external_path_string(sidecar_path)?,
            file_size_bytes: audio_metadata.len(),
            sha256: sidecar.output_sha256,
            missing: false,
            created_at_ms: sidecar.created_at_ms,
            updated_at_ms: sidecar.created_at_ms,
        };
        if let Err(error) = self.insert_library_item(&item) {
            if inserted_job == 1 {
                let _ = self
                    .lock()?
                    .execute("DELETE FROM jobs WHERE id=?1", [&item.job_id]);
            }
            return Err(error);
        }
        Ok(true)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| AppError::Internal("The local database is unavailable".into()))
    }
}

fn where_clause(clauses: &[String]) -> String {
    if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    }
}

fn row_to_job_detail(row: &Row<'_>) -> rusqlite::Result<JobDetail> {
    let state: String = row.get("state")?;
    let request_json: String = row.get("request_json")?;
    let progress_json: String = row.get("progress_json")?;
    let request: EnqueueItem = from_json_column(request_json)?;
    let progress: JobProgress = from_json_column(progress_json)?;
    let state = JobState::from_db(&state).ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    Ok(JobDetail {
        summary: QueueJob {
            id: row.get("id")?,
            client_item_id: row.get("client_item_id")?,
            state,
            queue_position: row.get("queue_position")?,
            revision: row.get("revision")?,
            source: request.source.clone(),
            title: request.metadata.title.clone(),
            artist: request.metadata.artist.clone(),
            preset_id: request.export.preset_id,
            progress,
            output_path: row.get("output_path")?,
            sidecar_path: row.get("sidecar_path")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            attempt: row.get("attempt")?,
            created_at_ms: row.get("created_at_ms")?,
            started_at_ms: row.get("started_at_ms")?,
            finished_at_ms: row.get("finished_at_ms")?,
        },
        request,
        working_directory: row.get("working_directory")?,
    })
}

fn row_to_library_item(row: &Row<'_>) -> rusqlite::Result<LibraryItem> {
    Ok(LibraryItem {
        id: row.get("id")?,
        job_id: row.get("job_id")?,
        client_item_id: row.get("client_item_id")?,
        source: from_json_column(row.get("source_json")?)?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        thumbnail_url: row.get("thumbnail_url")?,
        bpm: row.get("bpm")?,
        alternate_bpms: from_json_column(row.get("alternate_bpms_json")?)?,
        key: row.get("musical_key")?,
        camelot: row.get("camelot")?,
        detune_cents: row.get("detune_cents")?,
        tuning_hz: row.get("tuning_hz")?,
        preset_id: from_json_column(row.get("preset_id")?)?,
        format: row.get("format")?,
        codec: row.get("codec")?,
        duration_ms: row
            .get::<_, Option<i64>>("duration_ms")?
            .map(|value| value.max(0) as u64),
        sample_rate_hz: row.get("sample_rate_hz")?,
        channels: row.get("channels")?,
        audio_path: row.get("audio_path")?,
        sidecar_path: row.get("sidecar_path")?,
        file_size_bytes: row.get::<_, i64>("file_size_bytes")?.max(0) as u64,
        sha256: row.get("sha256")?,
        missing: row.get::<_, i64>("missing")? != 0,
        created_at_ms: row.get("created_at_ms")?,
        updated_at_ms: row.get("updated_at_ms")?,
    })
}

fn from_json_column<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn add_event(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
    state: JobState,
    code: &str,
    details: Option<&serde_json::Value>,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO job_events(job_id,state,message_code,details_json,created_at_ms) VALUES(?1,?2,?3,?4,?5)",
        params![id, state.as_str(), code, details.map(serde_json::to_string).transpose().map_err(|_| rusqlite::Error::InvalidQuery)?, now_ms()],
    )?;
    Ok(())
}

fn bump_queue_revision(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE queue_state SET revision=revision+1,updated_at_ms=?1 WHERE id=1",
        [now_ms()],
    )?;
    Ok(())
}

fn apply_settings_patch(settings: &mut AppSettings, patch: SettingsPatch) -> AppResult<()> {
    if let Some(value) = patch.default_output_directory {
        if value.chars().count() > 1_024 || value.chars().any(char::is_control) {
            return Err(crate::error::invalid("The default output path is invalid"));
        }
        settings.default_output_directory =
            (!value.trim().is_empty()).then(|| value.trim().to_string());
    }
    if let Some(value) = patch.filename_template {
        if value.trim().is_empty()
            || value.chars().count() > 240
            || value.chars().any(char::is_control)
        {
            return Err(crate::error::invalid("The filename template is invalid"));
        }
        settings.filename_template = value;
    }
    if let Some(value) = patch.default_preset_id {
        settings.default_preset_id = value;
    }
    if let Some(value) = patch.max_concurrent_jobs {
        if !(1..=3).contains(&value) {
            return Err(crate::error::invalid(
                "Concurrent jobs must be between 1 and 3",
            ));
        }
        settings.max_concurrent_jobs = value;
    }
    if let Some(value) = patch.history_enabled {
        settings.history_enabled = value;
    }
    if let Some(value) = patch.write_embedded_tags {
        settings.write_embedded_tags = value;
    }
    if let Some(value) = patch.include_source_path_in_sidecar {
        settings.include_source_path_in_sidecar = value;
    }
    if let Some(value) = patch.max_duration_minutes {
        if !(1..=360).contains(&value) {
            return Err(crate::error::invalid(
                "Duration limit must be between 1 and 360 minutes",
            ));
        }
        settings.max_duration_minutes = value;
    }
    if let Some(value) = patch.max_input_bytes {
        if !(1024 * 1024..=20 * 1024 * 1024 * 1024).contains(&value) {
            return Err(crate::error::invalid(
                "Input size limit must be between 1 MiB and 20 GiB",
            ));
        }
        settings.max_input_bytes = value;
    }
    Ok(())
}

fn is_running(state: JobState) -> bool {
    matches!(
        state,
        JobState::Preparing
            | JobState::Acquiring
            | JobState::Copying
            | JobState::Transcoding
            | JobState::Tagging
            | JobState::Validating
            | JobState::Publishing
    )
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn saturating_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        metadata::MusicMetadata,
        models::{AudioProperties, ExportSpec, FinalMetadata, SourceInspection, SourceSpec},
        sidecar::{SidecarSource, SonicSidecar, TagStatus, SIDECAR_SCHEMA_VERSION},
    };

    fn repository() -> (Repository, PathBuf) {
        let root = std::env::temp_dir().join(format!("sonic-db-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        (Repository::open_at(&root).unwrap(), root)
    }

    fn request(client: &str) -> EnqueueItem {
        let source = SourceSpec::LocalFile {
            path: "C:\\beat.wav".into(),
        };
        EnqueueItem {
            client_item_id: Some(client.into()),
            source: source.clone(),
            expected_fingerprint: Some("sha256:test".into()),
            inspection: SourceInspection {
                id: "inspection".into(),
                source,
                source_fingerprint: "sha256:test".into(),
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
                    file_size_bytes: Some(10),
                },
                declared_metadata: MusicMetadata::default(),
                embedded_metadata: MusicMetadata::default(),
                suggested_metadata: MusicMetadata::default(),
                audio_analysis: None,
                warnings: vec![],
            },
            metadata: FinalMetadata {
                title: "Beat".into(),
                ..Default::default()
            },
            export: ExportSpec::default(),
            output_directory: "C:\\output".into(),
            filename_template: "{title}".into(),
        }
    }

    #[test]
    fn migrates_empty_database_and_persists_settings() {
        let (repository, root) = repository();
        assert_eq!(repository.get_settings().unwrap().revision, 1);
        let updated = repository
            .update_settings(
                SettingsPatch {
                    max_concurrent_jobs: Some(3),
                    ..Default::default()
                },
                1,
            )
            .unwrap();
        assert_eq!(updated.settings.max_concurrent_jobs, 3);
        assert!(repository
            .update_settings(SettingsPatch::default(), 1)
            .is_err());
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claims_jobs_in_persistent_order_and_retries_terminal_jobs() {
        let (repository, root) = repository();
        let first = repository.insert_job(&request("one")).unwrap();
        let second = repository.insert_job(&request("two")).unwrap();
        assert_eq!(
            repository.claim_next_job().unwrap().unwrap().summary.id,
            first.id
        );
        repository.fail_job(&first.id, "test", "failed").unwrap();
        assert_eq!(
            repository.claim_next_job().unwrap().unwrap().summary.id,
            second.id
        );
        let retried = repository
            .retry_job_with_cleanup(&first.id, |_| Ok(()))
            .unwrap();
        assert_eq!(retried.state, JobState::Queued);
        assert_eq!(retried.attempt, 1);
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_detected_bpm_is_revision_safe_and_preserves_manual_values() {
        use crate::audio_analysis::{AudioAnalysis, TempoEstimate, ANALYZER_VERSION};

        let (repository, root) = repository();
        let analysis = AudioAnalysis {
            source_sha256: "a".repeat(64),
            analyzer_version: ANALYZER_VERSION.into(),
            analyzed_duration_ms: 30_000,
            bpm: Some(TempoEstimate {
                primary: 128.0,
                alternates: vec![64.0, 256.0],
                confidence: 0.9,
            }),
            key: None,
            warnings: vec![],
        };

        let blank_job = repository.insert_job(&request("blank-analysis")).unwrap();
        let claimed = repository.claim_next_job().unwrap().unwrap();
        assert!(repository
            .apply_audio_analysis(&blank_job.id, blank_job.revision, &analysis)
            .is_err());
        let applied = repository
            .apply_audio_analysis(&blank_job.id, claimed.summary.revision, &analysis)
            .unwrap();
        assert_eq!(applied.request.metadata.bpm, Some(128.0));
        assert!(applied.request.inspection.audio_analysis.is_some());

        repository
            .fail_job(&blank_job.id, "test", "advance queue")
            .unwrap();
        let mut manual_request = request("manual-analysis");
        manual_request.metadata.bpm = Some(140.0);
        repository.insert_job(&manual_request).unwrap();
        let manual = repository.claim_next_job().unwrap().unwrap();
        let applied = repository
            .apply_audio_analysis(&manual.summary.id, manual.summary.revision, &analysis)
            .unwrap();
        assert_eq!(applied.request.metadata.bpm, Some(140.0));

        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_retry_and_remove_never_clean_an_active_workspace() {
        use std::sync::atomic::{AtomicBool, Ordering};

        use crate::filesystem::{prepare_workspace, safe_cleanup_workspace};

        let (repository, root) = repository();
        let output = root.join("exports");
        fs::create_dir(&output).unwrap();
        let output = output.canonicalize().unwrap();
        let mut item = request("stale-mutation");
        item.output_directory = output.to_string_lossy().into_owned();
        let job = repository.insert_job(&item).unwrap();

        repository.claim_next_job().unwrap().unwrap();
        repository.fail_job(&job.id, "test", "failed").unwrap();
        repository
            .retry_job_with_cleanup(&job.id, |_| Ok(()))
            .unwrap();
        repository.claim_next_job().unwrap().unwrap();

        let workspace = prepare_workspace(&output, &job.id).unwrap();
        repository
            .update_job_state(
                &job.id,
                JobState::Preparing,
                &JobProgress::default(),
                Some(&workspace),
            )
            .unwrap();

        let retry_cleanup_called = AtomicBool::new(false);
        let retry_result = repository.retry_job_with_cleanup(&job.id, |_| {
            retry_cleanup_called.store(true, Ordering::Release);
            assert!(safe_cleanup_workspace(&workspace, &output, &job.id));
            Ok(())
        });
        assert!(retry_result.is_err());
        assert!(!retry_cleanup_called.load(Ordering::Acquire));
        assert!(workspace.exists());

        let remove_cleanup_called = AtomicBool::new(false);
        let remove_result = repository.remove_job_with_cleanup(&job.id, |_| {
            remove_cleanup_called.store(true, Ordering::Release);
            assert!(safe_cleanup_workspace(&workspace, &output, &job.id));
            Ok(())
        });
        assert!(remove_result.is_err());
        assert!(!remove_cleanup_called.load(Ordering::Acquire));
        assert!(workspace.exists());

        assert!(safe_cleanup_workspace(&workspace, &output, &job.id));
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queue_reorder_is_revision_guarded_and_exact() {
        let (repository, root) = repository();
        let first = repository.insert_job(&request("one")).unwrap();
        let second = repository.insert_job(&request("two")).unwrap();
        let snapshot = repository.queue_snapshot().unwrap();
        let reordered = repository
            .reorder_queue(&[second.id.clone(), first.id.clone()], snapshot.revision)
            .unwrap();
        assert_eq!(reordered.jobs[0].id, second.id);
        assert!(repository
            .reorder_queue(&[first.id], reordered.revision)
            .is_err());
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn database_reopens_with_settings_and_queue_intact() {
        let (repository, root) = repository();
        let job = repository.insert_job(&request("persisted")).unwrap();
        repository
            .update_settings(
                SettingsPatch {
                    history_enabled: Some(false),
                    ..Default::default()
                },
                1,
            )
            .unwrap();
        drop(repository);
        let reopened = Repository::open_at(&root).unwrap();
        assert_eq!(
            reopened.job(&job.id).unwrap().client_item_id.as_deref(),
            Some("persisted")
        );
        assert!(!reopened.get_settings().unwrap().settings.history_enabled);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn initialization_applies_all_library_intelligence_migrations() {
        let (repository, root) = repository();

        let conn = repository.lock().unwrap();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DB_SCHEMA_VERSION);

        // Verify new tables exist
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='library_roots'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            table_exists,
            "library_roots table should exist after v2 migration"
        );

        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='tags'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(table_exists, "tags table should exist after v2 migration");

        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='collections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            table_exists,
            "collections table should exist after v2 migration"
        );

        let columns = conn
            .prepare("PRAGMA table_info(library_items)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.iter().any(|name| name == "is_favorite"));
        assert!(columns.iter().any(|name| name == "variant_group_id"));

        drop(conn);
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn database_backup_created_before_migration() {
        let (repository, root) = repository();

        // Create a backup
        let conn = repository.lock().unwrap();
        let backup_result = repository.backup_database(&conn);
        drop(conn);

        assert!(
            backup_result.is_ok(),
            "Backup should be created successfully"
        );
        let backup_path = backup_result.unwrap();
        assert!(backup_path.exists(), "Backup file should exist");
        assert!(
            backup_path
                .extension()
                .is_some_and(|value| value == "sqlite3"),
            "Backup should have .sqlite3 extension"
        );

        // Clean up
        let _ = fs::remove_file(&backup_path);
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_sidecar_scan_imports_verified_audio_without_an_existing_job() {
        let (repository, root) = repository();
        let audio_path = root.join("import.wav");
        let sidecar_directory = root.join(".json");
        fs::create_dir(&sidecar_directory).unwrap();
        let sidecar_path = sidecar_directory.join("import.wav.sonic.json");
        fs::write(&audio_path, b"verified synthetic audio").unwrap();
        let hash = crate::tools::sha256_file(&audio_path).unwrap();
        let sidecar = SonicSidecar {
            schema_version: SIDECAR_SCHEMA_VERSION,
            sonic_version: env!("CARGO_PKG_VERSION").into(),
            library_item_id: "imported-item".into(),
            job_id: "imported-job".into(),
            client_item_id: None,
            created_at_ms: 123,
            source: SidecarSource {
                kind: "localFile".into(),
                source_fingerprint: "sha256:source".into(),
                provider_id: None,
                canonical_url: None,
                file_name: Some("source.wav".into()),
                original_path: None,
            },
            metadata: FinalMetadata {
                title: "Imported beat".into(),
                ..Default::default()
            },
            audio_analysis: None,
            inspection_audio: AudioProperties::default(),
            output_audio: AudioProperties {
                container: Some("wav".into()),
                file_size_bytes: Some(24),
                ..Default::default()
            },
            export: ExportSpec::default(),
            output_sha256: hash,
            tag_status: TagStatus {
                requested: false,
                supported: true,
                readback_verified: true,
                warnings: vec![],
            },
        };
        fs::write(&sidecar_path, serde_json::to_vec(&sidecar).unwrap()).unwrap();

        let report = repository
            .scan_sidecar_folder(root.to_str().unwrap(), true)
            .unwrap();
        assert_eq!(report.imported_count, 1);
        assert_eq!(report.error_count, 0);
        assert_eq!(
            repository.library_item("imported-item").unwrap().title,
            "Imported beat"
        );
        assert_eq!(
            PathBuf::from(
                repository
                    .job_detail("imported-job")
                    .unwrap()
                    .request
                    .output_directory
            )
            .canonicalize()
            .unwrap(),
            root.canonicalize().unwrap()
        );

        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }
}
