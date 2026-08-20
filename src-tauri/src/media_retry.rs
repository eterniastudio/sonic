use std::{future::Future, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryDecision {
    Retryable,
    Permanent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct RetryFailure<E> {
    pub attempts: u32,
    pub error: E,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 4 }
    }
}

pub fn classify_media_failure(message: &str) -> RetryDecision {
    let message = message.to_ascii_lowercase();
    let permanent = [
        "private video",
        "video unavailable",
        "has been removed",
        "sign in to confirm your age",
        "login required",
        "is live",
        "live video",
        "unsupported url",
        "exceeds sonic's configured size limit",
        "exceeds the configured duration limit",
        "was cancelled",
        "operation was cancelled",
    ];
    if permanent.iter().any(|pattern| message.contains(pattern)) {
        return RetryDecision::Permanent;
    }

    let retryable = [
        "timed out",
        "timeout",
        "connection reset",
        "connection refused",
        "connection aborted",
        "temporary failure",
        "http error 408",
        "http error 425",
        "http error 429",
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
        "too many requests",
        "service unavailable",
        "remote end closed",
        "incomplete read",
        "unexpected eof",
        "eof while parsing",
        "invalid metadata",
        "empty metadata",
        "ended unexpectedly",
    ];
    if retryable.iter().any(|pattern| message.contains(pattern)) {
        RetryDecision::Retryable
    } else {
        RetryDecision::Permanent
    }
}

pub fn retry_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(2);
    Duration::from_millis(500_u64.saturating_mul(1_u64 << exponent))
}

pub async fn run_with_retry<T, E, Operation, OperationFuture, Sleep, SleepFuture>(
    policy: RetryPolicy,
    mut operation: Operation,
    mut sleep: Sleep,
) -> Result<T, RetryFailure<E>>
where
    E: ToString,
    Operation: FnMut(u32) -> OperationFuture,
    OperationFuture: Future<Output = Result<T, E>>,
    Sleep: FnMut(Duration) -> SleepFuture,
    SleepFuture: Future<Output = ()>,
{
    let max_attempts = policy.max_attempts.max(1);
    for attempt in 1..=max_attempts {
        match operation(attempt).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let retryable =
                    classify_media_failure(&error.to_string()) == RetryDecision::Retryable;
                if !retryable || attempt == max_attempts {
                    return Err(RetryFailure {
                        attempts: attempt,
                        error,
                    });
                }
                sleep(retry_delay(attempt)).await;
            }
        }
    }
    unreachable!("the retry loop always returns")
}

pub async fn sleep(delay: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
}

pub fn format_exhausted_error(stage: &str, attempts: u32, message: &str) -> String {
    format!(
        "Sonic could not complete {stage} after {attempts} attempts: {}. Check your connection and try again.",
        redact_urls(message)
    )
}

fn redact_urls(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            if part.starts_with("http://") || part.starts_with("https://") {
                "[redacted URL]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_failures_that_can_change_without_user_action() {
        for message in [
            "The operation timed out",
            "Connection reset by peer",
            "HTTP Error 429: Too Many Requests",
            "HTTP Error 503: Service Unavailable",
            "Remote end closed connection without response",
            "yt-dlp returned invalid metadata: EOF while parsing",
            "yt-dlp returned empty metadata",
        ] {
            assert_eq!(
                classify_media_failure(message),
                RetryDecision::Retryable,
                "expected retryable: {message}"
            );
        }

        for message in [
            "Private video",
            "Video unavailable",
            "This video has been removed",
            "Sign in to confirm your age",
            "This video is live",
            "The selected source exceeds Sonic's configured size limit",
            "The source exceeds the configured duration limit",
            "The operation was cancelled",
        ] {
            assert_eq!(
                classify_media_failure(message),
                RetryDecision::Permanent,
                "expected permanent: {message}"
            );
        }
    }

    #[test]
    fn backoff_is_bounded_and_exhaustion_is_actionable() {
        assert_eq!(RetryPolicy::default().max_attempts, 4);
        assert_eq!(retry_delay(1), std::time::Duration::from_millis(500));
        assert_eq!(retry_delay(2), std::time::Duration::from_secs(1));
        assert_eq!(retry_delay(3), std::time::Duration::from_secs(2));
        assert_eq!(retry_delay(99), std::time::Duration::from_secs(2));

        let message = format_exhausted_error(
            "source inspection",
            4,
            "https://signed.example/video?token=secret HTTP Error 503",
        );
        assert!(message.contains("4 attempts"));
        assert!(message.contains("source inspection"));
        assert!(!message.contains("token=secret"));
        assert!(!message.contains("signed.example"));
    }

    #[test]
    fn operation_runner_recovers_without_a_manual_retry() {
        let attempts = std::cell::Cell::new(0_u32);
        let result = tauri::async_runtime::block_on(run_with_retry(
            RetryPolicy::default(),
            |_| {
                attempts.set(attempts.get() + 1);
                std::future::ready(if attempts.get() < 3 {
                    Err("HTTP Error 503: Service Unavailable")
                } else {
                    Ok("metadata")
                })
            },
            |_| std::future::ready(()),
        ));

        assert_eq!(result.unwrap(), "metadata");
        assert_eq!(attempts.get(), 3);
    }

    #[test]
    fn operation_runner_does_not_repeat_permanent_failures() {
        let attempts = std::cell::Cell::new(0_u32);
        let result = tauri::async_runtime::block_on(run_with_retry(
            RetryPolicy::default(),
            |_| {
                attempts.set(attempts.get() + 1);
                std::future::ready(Err::<(), _>("Private video"))
            },
            |_| std::future::ready(()),
        ));

        let failure = result.unwrap_err();
        assert_eq!(failure.attempts, 1);
        assert_eq!(failure.error, "Private video");
        assert_eq!(attempts.get(), 1);
    }
}
