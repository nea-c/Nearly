//! Windows-only presentation. Native Engine owns all status decisions.
use crate::{engine::Engine, taskbar_status::TaskbarState};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{image::Image, window::{ProgressBarState, ProgressBarStatus}, Manager};

/// The stop token is the existing application shutdown flag, not frontend state.
pub fn start(app: tauri::AppHandle, engine: Arc<Engine>, ownership:Arc<Mutex<crate::window_ownership::Registry>>, closing: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut applied = HashMap::new();
        while !closing.load(Ordering::SeqCst) {
            let windows=app.webview_windows();
            applied.retain(|label,_|windows.contains_key(label));
            for (label, window) in windows {
                if label=="tab-drag-preview"{continue;}
                let state=ownership.lock().map_err(|_|()).and_then(|r|engine.taskbar_state_for(&r.job_ids(&label)).map(|state|if state==TaskbarState::Idle&&r.has_stopped_sync(&label){TaskbarState::Paused}else{state}).map_err(|_|())).unwrap_or(TaskbarState::Error);
                if applied.get(&label) != Some(&state) {
                    // These API results indicate dispatch, not proof of shell rendering.
                    // Leave applied unchanged on failure so a following tick retries.
                    if apply(&window, state).is_ok() {
                        applied.insert(label, state);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

pub fn apply(window: &tauri::WebviewWindow, state: TaskbarState) -> tauri::Result<()> {
    let (status, progress) = match state {
        TaskbarState::Idle | TaskbarState::Paused | TaskbarState::CaughtUp => (ProgressBarStatus::None, None),
        TaskbarState::Working => (ProgressBarStatus::Indeterminate, None),
        // This is an attention color, never a measured completion percentage.
        TaskbarState::Error => (ProgressBarStatus::Error, Some(100)),
    };
    // Clear stale completion before applying the new progress state.
    // Shell overlays have an OS-controlled position. Full composites preserve
    // the approved top-right placement without adding a second badge.
    window.set_overlay_icon(None)?;
    let index=match state {TaskbarState::Idle=>0,TaskbarState::Working=>1,TaskbarState::CaughtUp=>2,TaskbarState::Error=>3,TaskbarState::Paused=>4};
    crate::status_icon_native::apply(windows::Win32::Foundation::HWND(window.hwnd()?.0),index,[BASE,SYNC,DONE,ERROR,PAUSED]).map_err(|e|tauri::Error::Io(std::io::Error::other(e)))?;
    window.set_progress_bar(ProgressBarState { status: Some(status), progress })
}

// Decode full composites at compile time. Each transition borrows fixed RGBA
// pixels; no runtime image decoder or growing artwork cache is needed.
const BASE: Image<'static> = tauri::include_image!("./icons/icon-source.png");
const SYNC: Image<'static> = tauri::include_image!("./icons/badges/sync.png");
const DONE: Image<'static> = tauri::include_image!("./icons/badges/done.png");
const ERROR: Image<'static> = tauri::include_image!("./icons/badges/error.png");
const PAUSED: Image<'static> = tauri::include_image!("./icons/badges/paused.png");

fn artwork(state: TaskbarState) -> Image<'static> {
    match state {
        TaskbarState::Idle => BASE,
        TaskbarState::Working => SYNC,
        TaskbarState::CaughtUp => DONE,
        TaskbarState::Error => ERROR,
        TaskbarState::Paused => PAUSED,
    }
}
#[cfg(test)]
mod artwork_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn supplied_badge_pixels_are_preserved_for_each_visible_state() {
        for (state, expected) in [
            (TaskbarState::Working, "51594a02ee74c330d1e7b686d137cabb66afaaa272d88ae551bb7065cf5da8ba"),
            (TaskbarState::CaughtUp, "dc00b71650a126936549f87ee9975c2cb7905639dbcc7766d6a35f011a8b668c"),
            (TaskbarState::Error, "3bbc99411c59c9ece45317af04f83aa47405fde0e397a302bec3a73cb063b347"),
            (TaskbarState::Paused, "e1d61dc21d222a0a5a6ea2cf72ccdb54ebe8742cfe7e8168e45238e7ff9f2655"),
        ] {
            let image=artwork(state);
            assert_eq!((image.width(),image.height()),(32,32));
            assert_eq!(Sha256::digest(image.rgba()).iter().map(|b|format!("{b:02x}")).collect::<String>(),expected);
            assert!(image.rgba().chunks_exact(4).any(|pixel|pixel[3]==0));
            assert!(image.rgba().chunks_exact(4).any(|pixel|pixel[3]>0));
        }
        assert_eq!(artwork(TaskbarState::Idle).rgba(), BASE.rgba());
    }
    #[test]
    fn repeated_image_selection_borrows_fixed_pixels_without_growing_a_cache() {
        for state in [TaskbarState::Working,TaskbarState::CaughtUp,TaskbarState::Error,TaskbarState::Paused] {
            let first=artwork(state);
            for _ in 0..4096 {
                let next=artwork(state);
                assert_eq!(first.rgba().as_ptr(),next.rgba().as_ptr(),"embedded pixels must be shared rather than decoded or allocated per transition");
            }
        }
    }
}
