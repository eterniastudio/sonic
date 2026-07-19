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
    error::{conflict, not_found, AppError, AppResult},
    models::{
        AppSettings, EnqueueItem, JobDetail, JobPage, JobProgress, JobQuery, JobState, LibraryItem,
        LibraryPage, LibraryQuery, QueueJob, QueueSnapshot, SettingsPatch, SettingsSnapshot,
    },
};

pub const DB_SCHEMA_VERSION: u32 = 1;
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
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
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
            transaction.pragma_update(None, "user_version", DB_SCHEMA_VERSION)?;
            transaction.commit()?;
        } else {
            let application_id: i64 =
                connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
            if application_id != APPLICATION_ID {
                return Err(AppError::Internal(
                    "The local database does not belong to Sonic".into(),
                ));
            }
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
                output_path.to_string_lossy(),
                sidecar_path.to_string_lossy(),
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
        let mut statement = connection
            .prepare("SELECT * FROM library_items ORDER BY created_at_ms DESC LIMIT 1000")?;
        let mut items = statement
            .query_map([], row_to_library_item)?
            .collect::<Result<Vec<_>, _>>()?;
        let search = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_lowercase);
        items.retain_mut(|item| {
            item.missing = !Path::new(&item.audio_path).is_file();
            search.as_ref().is_none_or(|search| {
                item.title.to_lowercase().contains(search)
                    || item
                        .artist
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(search)
                    || Path::new(&item.audio_path)
                        .file_name()
                        .map(|value| value.to_string_lossy().to_lowercase().contains(search))
                        .unwrap_or(false)
                    || item
                        .key
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(search)
                    || item
                        .camelot
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(search)
                    || item.bpm.is_some_and(|bpm| bpm.to_string().contains(search))
            }) && query.key.as_ref().is_none_or(|key| {
                item.key
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(key))
            }) && query
                .bpm_min
                .is_none_or(|min| item.bpm.is_some_and(|value| value >= min))
                && query
                    .bpm_max
                    .is_none_or(|max| item.bpm.is_some_and(|value| value <= max))
                && query
                    .format
                    .as_ref()
                    .is_none_or(|format| item.format.eq_ignore_ascii_case(format))
                && query.missing.is_none_or(|missing| item.missing == missing)
        });
        let offset = query
            .cursor
            .as_deref()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        let limit = query.limit.unwrap_or(50).clamp(1, 100) as usize;
        let page = items.iter().skip(offset).take(limit).cloned().collect();
        let next = (offset + limit < items.len()).then(|| (offset + limit).to_string());
        Ok(LibraryPage {
            items: page,
            next_cursor: next,
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

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| AppError::Internal("The local database is unavailable".into()))
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
}
