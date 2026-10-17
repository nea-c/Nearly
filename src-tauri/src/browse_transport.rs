use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
/// A single tab's serialized, read-only transport. Authentication stays in Sessions.
pub struct BrowseTransport<T> {
    connection: Mutex<Option<T>>,
    closed: AtomicBool,
}
impl<T> Default for BrowseTransport<T> {
    fn default() -> Self {
        Self {
            connection: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }
}
impl<T> BrowseTransport<T> {
    fn cancelled(&self, stop: &AtomicBool) -> bool {
        self.closed.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst)
    }
    fn lock(&self, stop: &AtomicBool) -> Result<std::sync::MutexGuard<'_, Option<T>>, String> {
        loop {
            if self.cancelled(stop) {
                return Err("Session browsing cancelled".into());
            }
            match self.connection.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Browsing transport lock failed".into())
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
            }
        }
    }
    fn release<R>(
        &self,
        guard: std::sync::MutexGuard<'_, Option<T>>,
        result: Result<R, String>,
        stop: &AtomicBool,
    ) -> Result<R, String> {
        // Check again after releasing ownership: cancellation that failed its
        // nonblocking clear just before unlock must not leave an idle socket.
        drop(guard);
        if self.cancelled(stop) {
            if let Ok(mut guard) = self.connection.try_lock() {
                guard.take();
            }
            return Err("Session browsing cancelled".into());
        }
        result
    }
    pub fn install(&self, connection: T, stop: &AtomicBool) -> Result<(), String> {
        let mut guard = self.lock(stop)?;
        if self.cancelled(stop) {
            guard.take();
            return Err("Session browsing cancelled".into());
        }
        if guard.is_some() {
            return self.release(
                guard,
                Err("Session browsing transport already installed".into()),
                stop,
            );
        }
        *guard = Some(connection);
        self.release(guard, Ok(()), stop)
    }
    pub fn read<R>(
        &self,
        stop: &AtomicBool,
        mut connect: impl FnMut() -> Result<T, String>,
        mut read: impl FnMut(&mut T) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut guard = self.lock(stop)?;
        for attempt in 0..2 {
            if self.cancelled(stop) {
                guard.take();
                return Err("Session browsing cancelled".into());
            }
            if guard.is_none() {
                let connection = connect()?;
                if self.cancelled(stop) {
                    return Err("Session browsing cancelled".into());
                }
                *guard = Some(connection);
            }
            let result = read(guard.as_mut().expect("Installed browsing transport"));
            if self.cancelled(stop) {
                guard.take();
                return Err("Session browsing cancelled".into());
            }
            match result {
                Ok(value) => return self.release(guard, Ok(value), stop),
                Err(error) => {
                    guard.take();
                    if attempt == 1 {
                        return Err(error);
                    }
                }
            }
        }
        unreachable!()
    }
    pub fn cancel(&self) {
        // Never wait for an in-flight reader while a session lifecycle lock is held.
        // Its caller also sets the shared stop token; the active reader drops its
        // channel before returning, and queued readers observe this permanent seal.
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
    struct Resource {
        generation: usize,
        drops: Arc<AtomicUsize>,
    }
    impl Drop for Resource {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn resource(generation: usize, drops: &Arc<AtomicUsize>) -> Resource {
        Resource {
            generation,
            drops: drops.clone(),
        }
    }
    #[test]
    fn cancellation_during_final_unlock_cannot_retain_an_idle_transport() {
        let pool = BrowseTransport::default();
        let stop = AtomicBool::new(false);
        let drops = Arc::new(AtomicUsize::new(0));
        pool.install(resource(1, &drops), &stop).unwrap();
        let guard = pool.connection.lock().unwrap();
        pool.cancel();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        assert!(pool.release(guard, Ok(()), &stop).is_err());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn queued_reader_cancels_without_waiting_for_the_busy_channel() {
        let pool = Arc::new(BrowseTransport::<Resource>::default());
        let stop = Arc::new(AtomicBool::new(false));
        let guard = pool.connection.lock().unwrap();
        let (done, received) = std::sync::mpsc::channel();
        let reader = pool.clone();
        let token = stop.clone();
        let thread = std::thread::spawn(move || {
            let result = reader.read(
                &token,
                || panic!("cancelled waiter authenticated"),
                |_| Ok(()),
            );
            done.send(result).unwrap();
        });
        stop.store(true, Ordering::SeqCst);
        pool.cancel();
        assert!(received
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .is_err());
        drop(guard);
        thread.join().unwrap();
    }
    #[test]
    fn late_authenticated_factory_result_is_dropped_after_disconnect() {
        let pool = Arc::new(BrowseTransport::<Resource>::default());
        let stop = Arc::new(AtomicBool::new(false));
        let drops = Arc::new(AtomicUsize::new(0));
        let (ready, started) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = pool.clone();
        let token = stop.clone();
        let count = drops.clone();
        let thread = std::thread::spawn(move || {
            worker.read(
                &token,
                || {
                    ready.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(resource(1, &count))
                },
                |_| -> Result<(), String> { panic!("cancelled factory result read") },
            )
        });
        started.recv().unwrap();
        stop.store(true, Ordering::SeqCst);
        pool.cancel();
        release.send(()).unwrap();
        assert!(thread.join().unwrap().is_err());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(pool.connection.lock().unwrap().is_none());
    }
    #[test]
    fn concurrent_tab_reads_are_serialized_on_the_same_channel() {
        let pool = Arc::new(BrowseTransport::default());
        let stop = Arc::new(AtomicBool::new(false));
        let drops = Arc::new(AtomicUsize::new(0));
        pool.install(resource(1, &drops), &stop).unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(std::sync::Barrier::new(3));
        let mut threads = vec![];
        for _ in 0..2 {
            let pool = pool.clone();
            let stop = stop.clone();
            let active = active.clone();
            let maximum = maximum.clone();
            let start = start.clone();
            threads.push(std::thread::spawn(move || {
                start.wait();
                pool.read(
                    &stop,
                    || panic!("serial reuse authenticated"),
                    |r| {
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(n, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(r.generation)
                    },
                )
                .unwrap()
            }));
        }
        start.wait();
        for t in threads {
            assert_eq!(t.join().unwrap(), 1);
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn healthy_reads_reuse_installed_transport_without_authentication() {
        let pool = BrowseTransport::default();
        let stop = AtomicBool::new(false);
        let drops = Arc::new(AtomicUsize::new(0));
        pool.install(resource(7, &drops), &stop).unwrap();
        for _ in 0..3 {
            assert_eq!(
                pool.read(
                    &stop,
                    || panic!("Healthy browsing must not authenticate again"),
                    |r| Ok(r.generation)
                )
                .unwrap(),
                7
            );
        }
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        pool.cancel();
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn failed_read_discards_transport_and_retries_only_once() {
        let pool = BrowseTransport::default();
        let stop = AtomicBool::new(false);
        let drops = Arc::new(AtomicUsize::new(0));
        pool.install(resource(1, &drops), &stop).unwrap();
        let mut connects = 0;
        assert_eq!(
            pool.read(
                &stop,
                || {
                    connects += 1;
                    Ok(resource(2, &drops))
                },
                |r| if r.generation == 1 {
                    Err("stale socket".into())
                } else {
                    Ok(r.generation)
                }
            )
            .unwrap(),
            2
        );
        assert_eq!(connects, 1);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        let mut reads = 0;
        assert!(pool
            .read(
                &stop,
                || {
                    connects += 1;
                    Ok(resource(3, &drops))
                },
                |_| {
                    reads += 1;
                    Err::<(), _>("read refused".into())
                }
            )
            .is_err());
        assert_eq!(reads, 2);
        assert_eq!(connects, 2);
        assert_eq!(drops.load(Ordering::SeqCst), 3);
    }
    #[test]
    fn disconnect_seals_idle_busy_and_late_install_without_reauthentication() {
        let pool = Arc::new(BrowseTransport::default());
        let stop = Arc::new(AtomicBool::new(false));
        let drops = Arc::new(AtomicUsize::new(0));
        pool.install(resource(1, &drops), &stop).unwrap();
        let (published, received) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = pool.clone();
        let workerstop = stop.clone();
        let thread = std::thread::spawn(move || {
            worker.read(
                &workerstop,
                || panic!("cancel must not reconnect"),
                |_| {
                    published.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                },
            )
        });
        received.recv().unwrap();
        stop.store(true, Ordering::SeqCst);
        pool.cancel();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        assert!(pool.install(resource(2, &drops), &stop).is_err());
        release.send(()).unwrap();
        assert!(thread.join().unwrap().is_err());
        assert_eq!(drops.load(Ordering::SeqCst), 2);
        assert!(pool
            .read(
                &stop,
                || panic!("sealed tab must not authenticate"),
                |_| Ok(())
            )
            .is_err());
    }
    #[test]
    fn tabs_do_not_share_channels_and_connect_failures_have_no_retry_loop() {
        let a = BrowseTransport::default();
        let b = BrowseTransport::default();
        let stop = AtomicBool::new(false);
        let drops = Arc::new(AtomicUsize::new(0));
        a.install(resource(1, &drops), &stop).unwrap();
        b.install(resource(2, &drops), &stop).unwrap();
        assert_eq!(a.read(&stop, || panic!(), |r| Ok(r.generation)).unwrap(), 1);
        assert_eq!(b.read(&stop, || panic!(), |r| Ok(r.generation)).unwrap(), 2);
        let c: BrowseTransport<Resource> = BrowseTransport::default();
        let mut connects = 0;
        assert!(c
            .read(
                &stop,
                || {
                    connects += 1;
                    Err("host key verification failed".into())
                },
                |_| Ok(())
            )
            .is_err());
        assert_eq!(connects, 1);
    }
}
