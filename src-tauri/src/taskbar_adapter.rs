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
    window.set_overlay_icon(overlay(state))?;
    window.set_progress_bar(ProgressBarState { status: Some(status), progress })
}

// Decode the supplied PNGs at compile time. Each transition borrows fixed RGBA
// pixels; no runtime image decoder or growing artwork cache is needed.
const SYNC: Image<'static> = tauri::include_image!("./icons/badges/sync.png");
const DONE: Image<'static> = tauri::include_image!("./icons/badges/done.png");
const ERROR: Image<'static> = tauri::include_image!("./icons/badges/error.png");
const PAUSED: Image<'static> = tauri::include_image!("./icons/badges/paused.png");

fn overlay(state: TaskbarState) -> Option<Image<'static>> {
    match state {
        TaskbarState::Idle => None,
        TaskbarState::Working => Some(SYNC),
        TaskbarState::CaughtUp => Some(DONE),
        TaskbarState::Error => Some(ERROR),
        TaskbarState::Paused => Some(PAUSED),
    }
}
#[cfg(test)]
mod artwork_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn supplied_badge_pixels_are_preserved_for_each_visible_state() {
        for (state, expected) in [
            (TaskbarState::Working, "4df5b0ee82021db9e8e0ce45015f2d2ce2153e954ee893c7b1c150a426732038"),
            (TaskbarState::CaughtUp, "f0d89cdfa24d9b45866d9f2a5208fb8eb2ed0982dd4f8efd2e0bead0f775ec97"),
            (TaskbarState::Error, "d6cc61120bfceebaa83b5cce2c3f13c91cf5267adc4e5c9c73d8917ec900d7f9"),
            (TaskbarState::Paused, "857fcc00b77853979f40d0b42aedd44c1e0a3afdcbbf93ea5196cc2a2bac5657"),
        ] {
            let image=overlay(state).expect("live state has its supplied artwork");
            assert_eq!((image.width(),image.height()),(16,16));
            assert_eq!(Sha256::digest(image.rgba()).iter().map(|b|format!("{b:02x}")).collect::<String>(),expected);
            assert!(image.rgba().chunks_exact(4).any(|pixel|pixel[3]==0));
            assert!(image.rgba().chunks_exact(4).any(|pixel|pixel[3]>0));
        }
        assert!(overlay(TaskbarState::Idle).is_none());
    }
    #[test]
    fn repeated_image_selection_borrows_fixed_pixels_without_growing_a_cache() {
        for state in [TaskbarState::Working,TaskbarState::CaughtUp,TaskbarState::Error,TaskbarState::Paused] {
            let first=overlay(state).unwrap();
            for _ in 0..4096 {
                let next=overlay(state).unwrap();
                assert_eq!(first.rgba().as_ptr(),next.rgba().as_ptr(),"embedded pixels must be shared rather than decoded or allocated per transition");
            }
        }
    }
}