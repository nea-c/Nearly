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
                let state=ownership.lock().map_err(|_|()).and_then(|r|engine.taskbar_state_for(&r.job_ids(&label)).map_err(|_|())).unwrap_or(TaskbarState::Error);
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
        TaskbarState::Idle | TaskbarState::CaughtUp => (ProgressBarStatus::None, None),
        TaskbarState::Working => (ProgressBarStatus::Indeterminate, None),
        // This is an attention color, never a measured completion percentage.
        TaskbarState::Error => (ProgressBarStatus::Error, Some(100)),
    };
    // Clear stale completion before applying the new progress state.
    window.set_overlay_icon(overlay(state))?;
    window.set_progress_bar(ProgressBarState { status: Some(status), progress })
}

fn overlay(state: TaskbarState) -> Option<Image<'static>> {
    let color = match state {
        TaskbarState::Idle => return None,
        TaskbarState::Working => [27, 110, 210, 255],
        TaskbarState::CaughtUp => [24, 135, 70, 255],
        TaskbarState::Error => [195, 42, 45, 255],
    };
    let mut rgba = vec![0; 16 * 16 * 4];
    for y in 0i32..16 {
        for x in 0i32..16 {
            let dx = 2 * x - 15;
            let dy = 2 * y - 15;
            let radius = dx * dx + dy * dy;
            if radius > 225 { continue; }
            let glyph = match state {
                TaskbarState::CaughtUp => {
                    // Two thick joined strokes form a check, not a color-only badge.
                    ((3..=7).contains(&x) && (y - x - 3).abs() <= 1)
                    || ((6..=12).contains(&x) && (y + x - 17).abs() <= 1)
                }
                TaskbarState::Error => (7..=8).contains(&x) && ((3..=9).contains(&y) || (11..=12).contains(&y)),
                TaskbarState::Working => {
                    ((4..=11).contains(&x) && (4..=5).contains(&y))
                    || ((4..=11).contains(&x) && (10..=11).contains(&y))
                    || ((9..=12).contains(&x) && (y - x + 6).abs() <= 1)
                    || ((3..=6).contains(&x) && (y - x - 5).abs() <= 1)
                }
                TaskbarState::Idle => false,
            };
            let pixel = if glyph || radius > 170 { [255, 255, 255, 255] } else { color };
            let offset = ((y * 16 + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&pixel);
        }
    }
    Some(Image::new_owned(rgba, 16, 16))
}
