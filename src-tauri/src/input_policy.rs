use std::{sync::mpsc, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyStatus {
    Verified,
    Unsupported,
    SettingsUnavailable,
    PasswordSettingFailed,
    VerificationFailed,
    NotEnforced,
    DispatchFailed,
    CompletionUnavailable,
}

impl PolicyStatus {
    fn diagnostic(self) -> &'static str {
        match self {
            Self::Verified => "input-policy: verified general-autofill=false password-autosave=false",
            Self::Unsupported => "input-policy: not verified; Settings4 unsupported",
            Self::SettingsUnavailable => "input-policy: not verified; native settings unavailable",
            Self::PasswordSettingFailed => "input-policy: not verified; password-autosave setting failed",
            Self::VerificationFailed => "input-policy: not verified; native getters failed",
            Self::NotEnforced => "input-policy: not verified; native getters still enabled",
            Self::DispatchFailed => "input-policy: not verified; native dispatch failed",
            Self::CompletionUnavailable => "input-policy: not verified; native completion unavailable",
        }
    }
}

type Observation = Result<(bool, bool), PolicyStatus>;
type Completion = Box<dyn FnOnce(Observation) + Send>;

fn observed_status(observed: Observation) -> PolicyStatus {
    match observed {
        Ok((false, false)) => PolicyStatus::Verified,
        Ok(_) => PolicyStatus::NotEnforced,
        Err(status) => status,
    }
}

fn complete_policy(dispatch: impl FnOnce(Completion) -> Result<(), ()>, timeout: Duration) -> PolicyStatus {
    let (send, receive) = mpsc::channel();
    if dispatch(Box::new(move |observed| { let _ = send.send(observed); })).is_err() {
        return PolicyStatus::DispatchFailed;
    }
    match receive.recv_timeout(timeout) {
        Ok(observed) => observed_status(observed),
        Err(_) => PolicyStatus::CompletionUnavailable,
    }
}

/// Called only during main setup or hidden-window construction, before show.
/// The locked Tauri/Wry dispatcher executes UI-thread calls inline; a worker
/// queues the callback and waits for its result. Never pass COM objects out.
#[cfg(windows)]
fn apply(window: &tauri::WebviewWindow) -> PolicyStatus {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use webview2_core::{Interface, BOOL};

    complete_policy(|done| window.with_webview(move |webview| {
        let observed = (|| -> Observation {
            unsafe {
                let settings = webview.controller().CoreWebView2()
                    .and_then(|view| view.Settings()).map_err(|_| PolicyStatus::SettingsUnavailable)?;
                let settings4: ICoreWebView2Settings4 = settings.cast().map_err(|_| PolicyStatus::Unsupported)?;
                settings4.SetIsPasswordAutosaveEnabled(false).map_err(|_| PolicyStatus::PasswordSettingFailed)?;
                // General autofill is set through supported Tauri configuration.
                // Verify both independent switches rather than assuming defaults.
                let mut general = BOOL::default();
                let mut password = BOOL::default();
                settings4.IsGeneralAutofillEnabled(&mut general).map_err(|_| PolicyStatus::VerificationFailed)?;
                settings4.IsPasswordAutosaveEnabled(&mut password).map_err(|_| PolicyStatus::VerificationFailed)?;
                Ok((general.as_bool(), password.as_bool()))
            }
        })();
        done(observed);
    }).map_err(|_| ()), Duration::from_secs(5))
}

pub(crate) fn configure(window: &tauri::WebviewWindow) -> PolicyStatus {
    #[cfg(windows)]
    let status = apply(window);
    #[cfg(not(windows))]
    let status = { let _ = window; PolicyStatus::Unsupported };
    // Fixed diagnostic only: no values, identifiers, paths or raw COM errors.
    eprintln!("{}", status.diagnostic());
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn getters_must_both_be_false() {
        assert_eq!(observed_status(Ok((false, false))), PolicyStatus::Verified);
        for observed in [(true, false), (false, true), (true, true)] {
            assert_eq!(observed_status(Ok(observed)), PolicyStatus::NotEnforced);
        }
        assert_eq!(observed_status(Err(PolicyStatus::Unsupported)), PolicyStatus::Unsupported);
        assert_eq!(observed_status(Err(PolicyStatus::PasswordSettingFailed)), PolicyStatus::PasswordSettingFailed);
        assert_eq!(observed_status(Err(PolicyStatus::VerificationFailed)), PolicyStatus::VerificationFailed);
    }

    #[test]
    fn inline_and_worker_completion_report_observation() {
        assert_eq!(complete_policy(|done| { done(Ok((false, false))); Ok(()) }, Duration::from_secs(1)), PolicyStatus::Verified);
        assert_eq!(complete_policy(|done| {
            std::thread::spawn(move || done(Ok((false, true)))); Ok(())
        }, Duration::from_secs(1)), PolicyStatus::NotEnforced);
    }

    #[test]
    fn dispatch_success_is_not_policy_success_and_failures_stay_truthful() {
        assert_eq!(complete_policy(|_done| Ok(()), Duration::ZERO), PolicyStatus::CompletionUnavailable);
        assert_eq!(complete_policy(|_done| Err(()), Duration::ZERO), PolicyStatus::DispatchFailed);
        assert_eq!(complete_policy(|done| { done(Err(PolicyStatus::Unsupported)); Ok(()) }, Duration::ZERO), PolicyStatus::Unsupported);
        assert_eq!(complete_policy(|done| {
            std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(20)); done(Ok((false,false))); });
            Ok(())
        }, Duration::from_millis(1)), PolicyStatus::CompletionUnavailable);
    }

    #[test]
    fn diagnostics_are_fixed_status_messages() {
        assert_eq!(PolicyStatus::Verified.diagnostic(), "input-policy: verified general-autofill=false password-autosave=false");
        for status in [PolicyStatus::Unsupported, PolicyStatus::SettingsUnavailable, PolicyStatus::PasswordSettingFailed,
            PolicyStatus::VerificationFailed, PolicyStatus::NotEnforced, PolicyStatus::DispatchFailed, PolicyStatus::CompletionUnavailable] {
            assert!(status.diagnostic().starts_with("input-policy: not verified; "));
        }
    }
}
