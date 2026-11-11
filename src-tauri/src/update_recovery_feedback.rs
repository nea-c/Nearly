//! Native feedback only. Choices and diagnostics never supply recovery authority.
use super::{fs, Error, RecoverySession};
use std::{cell::RefCell, fs::{File, OpenOptions}, io::Write, os::windows::fs::OpenOptionsExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Choice { Retry, Restore, Close }

fn choice(result: rfd::MessageDialogResult, can_restore: bool) -> Choice {
    use rfd::MessageDialogResult as R;
    match result {
        R::Custom(label) if label == "Retry" => Choice::Retry,
        R::Custom(label) if label == "Restore" && can_restore => Choice::Restore,
        R::Yes | R::Ok => Choice::Retry,
        R::No if can_restore => Choice::Restore,
        _ => Choice::Close,
    }
}

/// Called only after an actual sharing/lock error exhausts bounded retries.
/// The caller retains and revalidates all native capabilities after this returns.
pub(super) fn blocked(operation: &str, can_restore: bool) -> Choice {
    if cfg!(test) { return Choice::Close; }
    let description = format!(
        "Nearly could not complete {operation} because Windows reported a sharing or file-lock conflict. Automatic retries have finished.\n\nClose applications using Nearly's installation files before retrying. Do not delete .Nearly-update-state or its backups.\n\n{}Closing this dialog stops this recovery attempt; it does not undo completed changes.",
        if can_restore { "Yes = Retry.\nNo = Ask the current updater to restore the previous version after checking that it is safe.\nCancel = Close.\n\n" } else { "Yes = Retry.\nNo = Close.\nRestoration is not available at this step.\n\n" }
    );
    let buttons = if can_restore {
        rfd::MessageButtons::YesNoCancel
    } else {
        rfd::MessageButtons::YesNo
    };
    choice(rfd::MessageDialog::new().set_title("Nearly update needs attention")
        .set_level(rfd::MessageLevel::Warning).set_description(description)
        .set_buttons(buttons).show(), can_restore)
}

/// Retry requests another read-only startup admission check, never offline replay.
pub(super) fn startup_blocked(reason: &str) -> bool {
    if cfg!(test) { return false; }
    let description = format!(
        "Nearly cannot safely open while an update needs attention.\n\n{reason}\n\nIf an updater is still running, let it finish. Yes = Retry check. No = Close.\n\nRetry only checks whether Nearly can now open; it does not resume or restore an interrupted update.\n\nIf this message remains after the updater has stopped, run the Nearly installer again for this same installation folder. A successful reinstall preserves your settings and archives the interrupted recovery files. Do not delete .Nearly-update-state yourself."
    );
    matches!(rfd::MessageDialog::new().set_title("Nearly recovery required")
        .set_level(rfd::MessageLevel::Warning).set_description(description)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show(), rfd::MessageDialogResult::Yes)
}

thread_local! {
    static LOG: RefCell<Option<(String, File)>> = const { RefCell::new(None) };
}

fn site_code(site: &str) -> &str {
    if !site.is_empty() && site.len() <= 64
        && site.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        site
    } else { "unspecified" }
}

/// Best effort, fresh append-only file. Never opens a pre-existing log by name.
pub(super) fn record(session: &RecoverySession, site: &str, error: Option<&Error>) {
    let _ = (|| -> super::Result<()> {
        session.store.root.verify()?;
        let directory = session.directory();
        let guard = fs::directory(&directory, 0x80)?;
        if fs::identity(&fs::info(&guard)?) != fs::identity(&fs::info(&session._transaction)?) {
            return Err(Error::Unsafe);
        }
        LOG.with(|slot| -> super::Result<()> {
            let Ok(mut slot) = slot.try_borrow_mut() else { return Ok(()); };
            if slot.as_ref().is_none_or(|(nonce, _)| nonce != &session.record.nonce) {
                let name = format!("recovery-stop-{}.log", super::random_nonce()?);
                let file = OpenOptions::new().append(true).create_new(true)
                    .share_mode(5).custom_flags(super::REPARSE)
                    .open(directory.join(name)).map_err(|_| Error::Io)?;
                fs::regular(&file)?;
                *slot = Some((session.record.nonce.clone(), file));
            }
            let (_, file) = slot.as_mut().ok_or(Error::Uncertain)?;
            fs::regular(file)?;
            if file.metadata().map_err(|_| Error::Io)?.len() >= 256 * 1024 { return Ok(()); }
            let file_step = session.record.file_step.as_ref()
                .map(|step| (step.object, step.operation, step.status));
            let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map(|v| v.as_secs()).unwrap_or(0);
            writeln!(file, "time={timestamp} nonce={} phase={:?} step={:?} file_step={:?} site={} reason={:?}",
                session.record.nonce, session.record.engine.phase, session.record.engine.step,
                file_step, site_code(site), error).map_err(|_| Error::Io)?;
            file.flush().map_err(|_| Error::Io)?;
            Ok(())
        })
    })();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dialog_choices_never_grant_unavailable_restore() {
        use rfd::MessageDialogResult as R;
        assert_eq!(choice(R::Custom("Retry".into()), false), Choice::Retry);
        assert_eq!(choice(R::Custom("Restore".into()), false), Choice::Close);
        assert_eq!(choice(R::Custom("Restore".into()), true), Choice::Restore);
        assert_eq!(choice(R::Cancel, true), Choice::Close);
        assert_eq!(choice(R::Custom("unexpected".into()), true), Choice::Close);
    }
    #[test]
    fn diagnostics_reject_paths_and_multiline_sites() {
        assert_eq!(site_code("ApplyImage"), "ApplyImage");
        assert_eq!(site_code("C:\\private\\file"), "unspecified");
        assert_eq!(site_code("site\nother"), "unspecified");
    }
}

/// Terminal uncertainty cannot offer a mutation retry from reconstructed state.
pub(super) fn stopped(error: &Error) {
    if cfg!(test) { return; }
    rfd::MessageDialog::new().set_title("Nearly recovery stopped")
        .set_level(rfd::MessageLevel::Warning)
        .set_description(format!("The updater could not safely finish or restore the installation ({error:?}).\n\nIts recovery files have been kept in .Nearly-update-state. A diagnostic log may also be available there. Do not delete them.\n\nStart Nearly again to check whether it can open. If the incomplete-update message remains after the updater has stopped, run the Nearly installer again for the same installation folder. A successful reinstall preserves settings and archives the recovery evidence. An uncertain operation is never blindly replayed."))
        .set_buttons(rfd::MessageButtons::Ok).show();
}
