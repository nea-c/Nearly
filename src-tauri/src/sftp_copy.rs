//! Same-session copy: server-side copy-data when advertised, otherwise a
//! bounded READ/WRITE pipeline. No shell, temporary local file or extra login.
use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};

const CHUNK: u64 = 32 * 1024;
const WINDOW: usize = 32;
// Keep the interoperable 32KiB READ/WRITE size, but allow 1MiB of payload
// across 32 independent requests. Only one request per slot is outstanding.
// copy-data carries no payload: 4MiB reduces round trips without asking a
// server to finish an unbounded copy within the session's 15-second deadline.
// Cancellation waits for admitted requests to settle, never abandons a WRITE
// ACK, and never retries a timed-out chunk (its remote outcome is uncertain).
const SERVER_CHUNK: u64 = 4 * 1024 * 1024;

async fn sliding<'a, F, Fut>(expected: u64, stop: &AtomicBool, halted: &'a AtomicBool, transfer: F) -> Result<(), String>
where
    F: Fn(u64, u64, &'a AtomicBool) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut pending = FuturesUnordered::new();
    let mut next = 0;
    let mut failure = None;
    loop {
        if failure.is_none() {
            if let Err(error) = crate::file_ops::check(stop) {
                failure = Some(error);
                halted.store(true, Ordering::Relaxed);
            }
        }
        while failure.is_none() && next < expected && pending.len() < WINDOW {
            let end = next.saturating_add(CHUNK).min(expected);
            pending.push(transfer(next, end, halted));
            next = end;
        }
        let Some(result) = pending.next().await else { break; };
        if let Err(error) = result {
            if failure.is_none() { failure = Some(error); }
            // Drain all admitted siblings. Their outstanding WRITE ACKs still
            // count, but they must not issue another READ or WRITE after this.
            halted.store(true, Ordering::Relaxed);
        }
    }
    match failure { Some(error) => Err(error), None => Ok(()) }
}

fn copy_request(input: &[u8], output: &[u8], offset: u64, length: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(input.len() + output.len() + 32);
    data.extend_from_slice(&(input.len() as u32).to_be_bytes());
    data.extend_from_slice(input);
    data.extend_from_slice(&offset.to_be_bytes());
    data.extend_from_slice(&length.to_be_bytes());
    data.extend_from_slice(&(output.len() as u32).to_be_bytes());
    data.extend_from_slice(output);
    data.extend_from_slice(&offset.to_be_bytes());
    data
}

pub(super) async fn contents(
    s: &Connection, input: &[u8], output: &[u8], expected: u64,
    stop: &AtomicBool, progress: Option<&crate::operation_progress::Progress>,
) -> Result<(), String> {
    let mut offset = 0;
    let mut server_copy = s.copy_data.load(Ordering::Relaxed);
    while offset < expected && server_copy {
        crate::file_ops::check(stop)?;
        let length = (expected - offset).min(SERVER_CHUNK);
        match s.raw.extended("copy-data", copy_request(input, output, offset, length)).await {
            Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => {
                offset += length;
                if let Some(p) = progress { p.bytes(length); }
            }
            // Only an explicit unsupported response permits fallback. Never
            // replay an uncertain or failed server-side write.
            Ok(Packet::Status(status)) if status.status_code == StatusCode::OpUnsupported && offset == 0 => {
                s.copy_data.store(false, Ordering::Relaxed);
                server_copy = false;
            }
            _ => return Err("Remote server-side copy failed or outcome uncertain; partial target retained; source not removed".into()),
        }
    }
    // Server copy either completed everything or explicitly refused its first
    // request. Never mix relay with acknowledged server-side copy chunks.
    debug_assert!(offset == 0 || offset == expected);
    if offset == expected { return Ok(()); }
    let halted = AtomicBool::new(false);
    sliding(expected, stop, &halted, |start, limit, halted| async move {
        let check = || {
            crate::file_ops::check(stop)?;
            if halted.load(Ordering::Relaxed) {
                return Err("Remote copy stopped after sibling failure; partial target retained".to_owned());
            }
            Ok(())
        };
        let mut at = start;
        while at < limit {
            check()?;
            let data = s.raw.read(input.to_vec(), at, (limit-at) as u32).await
                .map_err(|_| "Remote copy read failed; partial target retained")?.data;
            // Short reads are legal: write only those bytes, then request the
            // remainder at the next offset. Empty/oversized DATA is an error;
            // no padding, skipped offsets, or replay of a previous WRITE.
            if data.is_empty() || data.len() as u64 > limit-at {
                return Err("Remote copy source size changed; partial target retained".to_owned());
            }
            let length = data.len() as u64;
            check()?;
            s.raw.write(output.to_vec(), at, data).await
                .map_err(|_| "Remote copy write failed or outcome uncertain; partial target retained")?;
            at += length;
            if let Some(p) = progress { p.bytes(length); }
        }
        Ok(())
    }).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn sliding_refills_without_waiting_for_slow_first_slot() {
        let stop = AtomicBool::new(false);
        let halted = AtomicBool::new(false);
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let completed = AtomicUsize::new(0);
        let release = tokio::sync::Notify::new();
        let run = sliding(CHUNK * (WINDOW as u64 + 1), &stop, &halted, |start, end, _| {
            let (active, peak, completed, release) = (&active, &peak, &completed, &release);
            async move {
                assert_eq!(end-start, CHUNK);
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                if start == 0 { release.notified().await; }
                else {
                    tokio::task::yield_now().await;
                    if start == CHUNK * WINDOW as u64 { release.notify_one(); }
                }
                active.fetch_sub(1, Ordering::SeqCst);
                completed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        });
        tokio::time::timeout(Duration::from_secs(2), run).await.unwrap().unwrap();
        assert_eq!(completed.load(Ordering::SeqCst), WINDOW + 1);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert!(peak.load(Ordering::SeqCst) <= WINDOW);
    }

    #[tokio::test]
    async fn sliding_failure_drains_acknowledgements_without_admitting_more() {
        let stop = AtomicBool::new(false);
        let halted = AtomicBool::new(false);
        let admitted = AtomicUsize::new(0);
        let acknowledged = AtomicUsize::new(0);
        let result = sliding(CHUNK * (WINDOW as u64 + 10), &stop, &halted, |start, _, halted| {
            admitted.fetch_add(1, Ordering::SeqCst);
            let acknowledged = &acknowledged;
            async move {
                if start == 0 { return Err("failed write".to_owned()); }
                tokio::task::yield_now().await;
                assert!(halted.load(Ordering::Relaxed));
                // Model already admitted WRITE ACKs, not new writes.
                acknowledged.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }).await;
        assert_eq!(result.unwrap_err(), "failed write");
        assert_eq!(admitted.load(Ordering::SeqCst), WINDOW);
        assert_eq!(acknowledged.load(Ordering::SeqCst), WINDOW - 1);
    }

    #[tokio::test]
    async fn sliding_pre_cancelled_admits_nothing() {
        let stop = AtomicBool::new(true);
        let halted = AtomicBool::new(false);
        assert!(sliding(CHUNK, &stop, &halted, |_, _, _| async {
            panic!("cancelled copy must not admit work");
            #[allow(unreachable_code)] Ok(())
        }).await.is_err());
    }
}