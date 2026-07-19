use serde::{ser::Serializer, Serialize};
use thiserror::Error;

const MAX_PUBLIC_ERROR_LENGTH: usize = 4_000;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Engine(String),
    #[error("{0}")]
    Process(String),
    #[error("{0}")]
    Cancelled(String),
    #[error("Database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("File operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Data serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "invalidInput",
            Self::NotFound(_) => "notFound",
            Self::Conflict(_) => "conflict",
            Self::Engine(_) => "engineUnavailable",
            Self::Process(_) => "processFailed",
            Self::Cancelled(_) => "cancelled",
            Self::Database(_) => "databaseError",
            Self::Io(_) => "fileError",
            Self::Json(_) => "invalidData",
            Self::Internal(_) => "internalError",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Engine(_) | Self::Process(_) | Self::Io(_) | Self::Database(_)
        )
    }

    pub fn public_message(&self) -> String {
        self.to_string()
            .trim()
            .chars()
            .take(MAX_PUBLIC_ERROR_LENGTH)
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl From<&AppError> for CommandError {
    fn from(value: &AppError) -> Self {
        Self {
            code: value.code().to_string(),
            message: value.public_message(),
            retryable: value.retryable(),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        CommandError::from(self).serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

pub fn conflict(message: impl Into<String>) -> AppError {
    AppError::Conflict(message.into())
}

pub fn not_found(message: impl Into<String>) -> AppError {
    AppError::NotFound(message.into())
}
