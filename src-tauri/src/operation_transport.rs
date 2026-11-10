//! One serialized mutation connection per immutable session generation.
//! Unlike browsing, an admitted operation is invoked exactly once, even on error.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

pub struct OperationTransport<T> {
    connection: Mutex<Option<T>>,
    closed: AtomicBool,
}
impl<T> Default for OperationTransport<T> {
    fn default() -> Self {
        Self {
            connection: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }
}
impl<T> OperationTransport<T> {
    fn cancelled(&self, stop: &AtomicBool) -> bool {
        self.closed.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst)
    }
    pub fn run<R>(
        &self,
        stop: &AtomicBool,
        connect: impl FnOnce() -> Result<T, String>,
        stale: impl FnOnce(&T) -> bool,
        operation: impl FnOnce(&mut T) -> Result<R, String>,
        reusable: impl FnOnce(&R) -> bool,
    ) -> Result<R, String> {
        let mut guard = loop {
            if self.cancelled(stop) {
                return Err("File operation cancelled before transport admission".into());
            }
            match self.connection.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("File-operation transport lock failed".into())
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
            }
        };
        if self.cancelled(stop) {
            return Err("File operation cancelled before transport admission".into());
        }
        // Only known-closed idle connections are replaced. A disconnect racing an
        // admitted operation fails that operation; it is never silently replayed.
        if guard.as_ref().is_some_and(stale) {
            guard.take();
        }
        if guard.is_none() {
            let connection = connect()?;
            if self.cancelled(stop) {
                return Err("File operation cancelled during connection setup".into());
            }
            *guard = Some(connection);
        }
        if self.cancelled(stop) {
            guard.take();
            return Err("File operation cancelled before mutation".into());
        }
        let result = operation(guard.as_mut().expect("Installed operation transport"));
        if self.cancelled(stop) || !result.as_ref().is_ok_and(reusable) {
            guard.take();
        }
        drop(guard);
        // Disconnect's nonblocking clear may have raced the final unlock.
        if self.cancelled(stop) {
            if let Ok(mut guard) = self.connection.try_lock() {
                guard.take();
            }
        }
        // Preserve acknowledged successes / partial per-item results, including
        // cancellation arriving just after the last acknowledgement.
        result
    }
    pub fn cancel(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.connection.try_lock() {
            guard.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};
    #[test]
    fn healthy_operations_reuse_connection_and_partial_outcomes_discard_it() {
        let pool = OperationTransport::default();
        let stop = AtomicBool::new(false);
        for _ in 0..2 {
            assert_eq!(
                pool.run(&stop, || Ok(7), |_| false, |v| Ok(*v), |_| true)
                    .unwrap(),
                7
            );
        }
        assert_eq!(
            pool.run(
                &stop,
                || panic!("unexpected authentication"),
                |_| false,
                |v| Ok(*v),
                |_| false
            )
            .unwrap(),
            7
        );
        assert_eq!(
            pool.run(&stop, || Ok(8), |_| false, |v| Ok(*v), |_| true)
                .unwrap(),
            8
        );
    }
    #[test]
    fn uncertain_mutation_is_never_replayed_and_next_request_reconnects() {
        let pool = OperationTransport::default();
        let stop = AtomicBool::new(false);
        let calls = AtomicUsize::new(0);
        assert!(pool
            .run(
                &stop,
                || Ok(1),
                |_| false,
                |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err::<(), _>("ack lost".into())
                },
                |_| true
            )
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            pool.run(&stop, || Ok(2), |_| false, |v| Ok(*v), |_| true)
                .unwrap(),
            2
        );
    }
    #[test]
    fn known_closed_idle_connection_replaced_before_single_admission() {
        let pool = OperationTransport::default();
        let stop = AtomicBool::new(false);
        pool.run(&stop, || Ok(1), |_| false, |_| Ok(()), |_| true)
            .unwrap();
        assert_eq!(
            pool.run(&stop, || Ok(2), |_| true, |v| Ok(*v), |_| true)
                .unwrap(),
            2
        );
    }
    #[test]
    fn cancelled_queue_does_not_close_active_operation_and_session_seal_is_permanent() {
        let pool = Arc::new(OperationTransport::<usize>::default());
        let guard = pool.connection.lock().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker = pool.clone();
        let token = stop.clone();
        let thread = std::thread::spawn(move || {
            worker.run(
                &token,
                || panic!("cancelled waiter authenticated"),
                |_| false,
                |_| Ok(()),
                |_| true,
            )
        });
        stop.store(true, Ordering::SeqCst);
        assert!(thread.join().unwrap().is_err());
        drop(guard);
        pool.cancel();
        assert!(pool
            .run(
                &AtomicBool::new(false),
                || panic!("sealed session authenticated"),
                |_| false,
                |_| Ok(()),
                |_| true
            )
            .is_err());
    }
    #[test]
    fn late_connection_and_cancelled_operation_are_not_retained() {
        let pool = OperationTransport::<usize>::default();
        let stop = AtomicBool::new(false);
        assert!(pool
            .run(
                &stop,
                || {
                    stop.store(true, Ordering::SeqCst);
                    Ok(1)
                },
                |_| false,
                |_| panic!("late connection mutated"),
                |_: &()| true
            )
            .is_err());
        assert!(pool.connection.lock().unwrap().is_none());
        stop.store(false, Ordering::SeqCst);
        assert_eq!(
            pool.run(
                &stop,
                || Ok(2),
                |_| false,
                |_| {
                    stop.store(true, Ordering::SeqCst);
                    Ok(42)
                },
                |_| true
            )
            .unwrap(),
            42
        );
        assert!(pool.connection.lock().unwrap().is_none());
    }
    #[test]
    fn concurrent_operations_serialize_without_reauthentication() {
        let pool = Arc::new(OperationTransport::default());
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let connects = Arc::new(AtomicUsize::new(0));
        let mut threads = vec![];
        for _ in 0..3 {
            let pool = pool.clone();
            let active = active.clone();
            let maximum = maximum.clone();
            let connects = connects.clone();
            threads.push(std::thread::spawn(move || {
                pool.run(
                    &AtomicBool::new(false),
                    || {
                        connects.fetch_add(1, Ordering::SeqCst);
                        Ok(1)
                    },
                    |_| false,
                    |v| {
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(*v)
                    },
                    |_| true,
                )
                .unwrap()
            }));
        }
        for t in threads {
            assert_eq!(t.join().unwrap(), 1);
        }
        assert_eq!(connects.load(Ordering::SeqCst), 1);
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn setup_failure_is_not_retried_and_other_sessions_are_independent() {
        let a = OperationTransport::<usize>::default();
        let b = OperationTransport::default();
        let stop = AtomicBool::new(false);
        let calls = AtomicUsize::new(0);
        assert!(a
            .run(
                &stop,
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err("host key rejected".into())
                },
                |_| false,
                |_| Ok(()),
                |_| true
            )
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            b.run(&stop, || Ok(2), |_| false, |v| Ok(*v), |_| true)
                .unwrap(),
            2
        );
        a.cancel();
        assert_eq!(
            b.run(&stop, || panic!(), |_| false, |v| Ok(*v), |_| true)
                .unwrap(),
            2
        );
    }
}
