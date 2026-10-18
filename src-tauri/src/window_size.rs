//! Native-only normal client size and physical outer placement.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub(crate) const SAVE_DELAY: Duration = Duration::from_millis(350);
const DEFAULT_WIDTH: f64 = 1180.;
const DEFAULT_HEIGHT: f64 = 850.;
const MIN_WIDTH: f64 = 800.;
const MIN_HEIGHT: f64 = 650.;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Placement {
    pub(crate) x: i32,
    pub(crate) y: i32,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedSize {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) placement: Option<Placement>,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) maximized: bool,
}
impl Default for SavedSize {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: false,
            placement: None,
        }
    }
}
impl SavedSize {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if ![self.width, self.height]
            .iter()
            .all(|n| n.is_finite() && *n >= 1. && *n <= 100_000.)
        {
            return Err("Invalid saved window size".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RestorePlan {
    pub(crate) saved: SavedSize,
    pub(crate) min_width: f64,
    pub(crate) min_height: f64,
}
pub(crate) fn restore_plan(
    saved: Option<SavedSize>,
    work_width: f64,
    work_height: f64,
) -> Result<RestorePlan, String> {
    if ![work_width, work_height]
        .iter()
        .all(|n| n.is_finite() && *n >= 1.)
    {
        return Err("Monitor work area is unavailable".into());
    }
    let saved = saved.filter(|s| s.validate().is_ok()).unwrap_or_default();
    let min_width = MIN_WIDTH.min(work_width);
    let min_height = MIN_HEIGHT.min(work_height);
    Ok(RestorePlan {
        saved: SavedSize {
            width: saved.width.clamp(min_width, work_width),
            height: saved.height.clamp(min_height, work_height),
            maximized: saved.maximized,
            placement: saved.placement,
        },
        min_width,
        min_height,
    })
}

/// One bounded debounce worker, owned only by the main native window.
#[derive(Default)]
pub(crate) struct Session {
    ready: bool,
    restoring: bool,
    last: SavedSize,
    dirty: bool,
    generation: u64,
    changed: Option<Instant>,
    worker: bool,
}
impl Session {
    pub(crate) fn begin_restore(&mut self) {
        self.restoring = true;
    }
    pub(crate) fn finish_restore(&mut self) {
        self.restoring = false;
    }
    pub(crate) fn seed(&mut self, saved: SavedSize) {
        self.last = saved;
    }
    pub(crate) fn activate(&mut self) {
        self.ready = true;
    }
    pub(crate) fn observe(
        &mut self,
        label: &str,
        width: f64,
        height: f64,
        maximized: bool,
        minimized: bool,
        fullscreen: bool,
    ) -> bool {
        if label != "main" || !self.ready || self.restoring || minimized || fullscreen {
            return false;
        }
        let mut next = self.last;
        next.maximized = maximized;
        if !maximized {
            // Quantize subpixel conversion noise without making physical pixels
            // the persisted unit across monitor DPI changes.
            next.width = (width * 10.).round() / 10.;
            next.height = (height * 10.).round() / 10.;
            if next.validate().is_err() {
                return false;
            }
        }
        if next == self.last {
            return false;
        }
        self.last = next;
        self.dirty = true;
        self.generation = self.generation.wrapping_add(1);
        self.changed = Some(Instant::now());
        if self.worker {
            return false;
        }
        self.worker = true;
        true
    }
    pub(crate) fn observe_placement(
        &mut self,
        label: &str,
        position: Placement,
        width: f64,
        height: f64,
        maximized: bool,
        minimized: bool,
        fullscreen: bool,
    ) -> bool {
        if label != "main" || !self.ready || self.restoring || minimized || fullscreen {
            return false;
        }
        if !maximized && (!width.is_finite() || !height.is_finite() || width < 1. || height < 1.) {
            return false;
        }
        let changed = !maximized && self.last.placement != Some(position);
        let start = self.observe(label, width, height, maximized, minimized, fullscreen);
        if changed {
            self.last.placement = Some(position);
            self.dirty = true;
            self.generation = self.generation.wrapping_add(1);
            self.changed = Some(Instant::now());
            if !self.worker {
                self.worker = true;
                return true;
            }
        }
        start
    }
    pub(crate) fn pending(&self, quiet: bool) -> Option<(SavedSize, u64)> {
        (self.dirty && (!quiet || self.changed.is_some_and(|at| at.elapsed() >= SAVE_DELAY)))
            .then_some((self.last, self.generation))
    }
    pub(crate) fn is_dirty(&self) -> bool {
        self.dirty
    }
    pub(crate) fn acknowledge(&mut self, generation: u64) {
        if self.generation == generation {
            self.dirty = false;
        }
    }
    pub(crate) fn stop_worker(&mut self) {
        self.worker = false;
    }
}

pub(crate) fn capture(
    window: &tauri::WebviewWindow,
) -> Result<(f64, f64, bool, bool, bool), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if !scale.is_finite() || scale <= 0. {
        return Err("Invalid window scale factor".into());
    }
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok((
        size.width as f64 / scale,
        size.height as f64 / scale,
        window.is_maximized().map_err(|e| e.to_string())?,
        window.is_minimized().map_err(|e| e.to_string())?,
        window.is_fullscreen().map_err(|e| e.to_string())?,
    ))
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct MonitorArea {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale: f64,
}
pub(crate) fn placement_plan(
    saved: Option<SavedSize>,
    monitors: &[MonitorArea],
    frame: (f64, f64),
) -> Result<RestorePlan, String> {
    if ![frame.0, frame.1].iter().all(|v| v.is_finite() && *v >= 0.) {
        return Err("Invalid window frame".into());
    }
    let saved = saved.filter(|s| s.validate().is_ok()).unwrap_or_default();
    let monitors: Vec<_> = monitors
        .iter()
        .filter(|m| {
            m.scale.is_finite()
                && m.scale > 0.
                && m.width.is_finite()
                && m.height.is_finite()
                && m.width > frame.0
                && m.height > frame.1
        })
        .collect();
    let distance = |m: &&MonitorArea| {
        let p = saved.placement.unwrap_or(Placement { x: m.x, y: m.y });
        let dx = (p.x as f64 - (p.x as f64).clamp(m.x as f64, m.x as f64 + m.width)).abs();
        let dy = (p.y as f64 - (p.y as f64).clamp(m.y as f64, m.y as f64 + m.height)).abs();
        dx * dx + dy * dy
    };
    let m = monitors
        .iter()
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .ok_or("Monitor unavailable")?;
    let mut plan = restore_plan(
        Some(saved),
        (m.width - frame.0) / m.scale,
        (m.height - frame.1) / m.scale,
    )?;
    // Quantize the actual native client size before calculating available travel.
    // Flooring the available physical pixels prevents native rounding from
    // extending the complete frame beyond the work area at fractional DPI.
    let physical_width = (plan.saved.width * m.scale)
        .round()
        .min((m.width - frame.0).floor());
    let physical_height = (plan.saved.height * m.scale)
        .round()
        .min((m.height - frame.1).floor());
    plan.saved.width = physical_width / m.scale;
    plan.saved.height = physical_height / m.scale;
    plan.min_width = plan.min_width.min(plan.saved.width);
    plan.min_height = plan.min_height.min(plan.saved.height);
    if let Some(p) = saved.placement {
        // Roundoff must never invert clamp bounds; integral travel also keeps
        // rounding the final desktop position from adding an off-screen pixel.
        let travel_x = (m.width - physical_width - frame.0).max(0.).floor();
        let travel_y = (m.height - physical_height - frame.1).max(0.).floor();
        plan.saved.placement = Some(Placement {
            x: (p.x as f64)
                .clamp(m.x as f64, m.x as f64 + travel_x)
                .round() as i32,
            y: (p.y as f64)
                .clamp(m.y as f64, m.y as f64 + travel_y)
                .round() as i32,
        });
    }
    Ok(plan)
}
fn monitor_areas(window: &tauri::WebviewWindow) -> Result<Vec<MonitorArea>, String> {
    window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| {
            let p = m.position();
            let size = m.size();
            let mut area = MonitorArea {
                x: p.x,
                y: p.y,
                width: size.width as f64,
                height: size.height as f64,
                scale: m.scale_factor(),
            };
            #[cfg(windows)]
            {
                use windows::Win32::Graphics::Gdi::{
                    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
                };
                let handle = unsafe {
                    MonitorFromPoint(
                        windows::Win32::Foundation::POINT { x: p.x, y: p.y },
                        MONITOR_DEFAULTTONEAREST,
                    )
                };
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if !unsafe { GetMonitorInfoW(handle, &mut info) }.as_bool() {
                    return Err("Monitor work area unavailable".into());
                }
                area.x = info.rcWork.left;
                area.y = info.rcWork.top;
                area.width = (info.rcWork.right as i64 - info.rcWork.left as i64) as f64;
                area.height = (info.rcWork.bottom as i64 - info.rcWork.top as i64) as f64;
            }
            Ok(area)
        })
        .collect()
}
pub(crate) fn restore(
    window: &tauri::WebviewWindow,
    saved: Option<SavedSize>,
) -> Result<SavedSize, String> {
    let mut initial = true;
    restore_with_visibility(
        saved,
        |normal| {
            let move_first = std::mem::replace(&mut initial, false);
            place_normal(window, Some(normal), move_first)
        },
        || window.show().map_err(|e| e.to_string()),
        || window.maximize().map_err(|e| e.to_string()),
    )
}

fn restore_with_visibility(
    saved: Option<SavedSize>,
    mut place: impl FnMut(SavedSize) -> Result<SavedSize, String>,
    show: impl FnOnce() -> Result<(), String>,
    maximize: impl FnOnce() -> Result<(), String>,
) -> Result<SavedSize, String> {
    let requested = saved.filter(|s| s.validate().is_ok()).unwrap_or_default();
    let mut normal = requested;
    normal.maximized = false;
    // A frameless shadow window can have different nonclient metrics while
    // hidden. Place it visibly inside a work area, then reapply the ORIGINAL
    // client preference using its shown frame. Keep the caller's restore gate
    // active throughout; never maximize or seed an inflated temporary client.
    place(normal)?;
    show()?;
    let mut restored = place(normal)?;
    if requested.maximized {
        maximize()?;
    }
    restored.maximized = requested.maximized;
    Ok(restored)
}

fn place_normal(
    window: &tauri::WebviewWindow,
    saved: Option<SavedSize>,
    move_first: bool,
) -> Result<SavedSize, String> {
    let monitors = monitor_areas(window)?;
    let current = window.outer_position().map_err(|e| e.to_string())?;
    let mut saved = saved.unwrap_or_default();
    if saved.placement.is_none() {
        saved.placement = Some(Placement {
            x: current.x,
            y: current.y,
        });
    }
    let saved = Some(saved);
    // Move first so the native frame metrics come from the selected destination DPI.
    let first = placement_plan(saved, &monitors, (0., 0.))?;
    if let Some(p) = first.saved.placement.filter(|_| move_first) {
        window
            .set_position(tauri::PhysicalPosition::new(p.x, p.y))
            .map_err(|e| e.to_string())?;
    }
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let current_scale = window.scale_factor().map_err(|e| e.to_string())?;
    if !current_scale.is_finite() || current_scale <= 0. {
        return Err("Invalid window scale factor".into());
    }
    let destination = first.saved.placement.ok_or("Placement unavailable")?;
    let target_scale = monitors
        .iter()
        .find(|m| {
            destination.x as f64 >= m.x as f64
                && (destination.x as f64) < m.x as f64 + m.width
                && destination.y as f64 >= m.y as f64
                && (destination.y as f64) < m.y as f64 + m.height
        })
        .ok_or("Monitor unavailable")?
        .scale;
    let ratio = target_scale / current_scale;
    let plan = placement_plan(
        saved,
        &monitors,
        (
            outer.width.saturating_sub(inner.width) as f64 * ratio,
            outer.height.saturating_sub(inner.height) as f64 * ratio,
        ),
    )?;
    window
        .set_min_size(Some(tauri::PhysicalSize::new(
            (plan.min_width * target_scale).round() as u32,
            (plan.min_height * target_scale).round() as u32,
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(
            (plan.saved.width * target_scale).round() as u32,
            (plan.saved.height * target_scale).round() as u32,
        ))
        .map_err(|e| e.to_string())?;
    if let Some(p) = plan.saved.placement {
        window
            .set_position(tauri::PhysicalPosition::new(p.x, p.y))
            .map_err(|e| e.to_string())?;
    }
    // Capture before maximize so the session seeds the real corrected normal
    // geometry, including native rounding. The second placement stays on the
    // already selected monitor and only moves after its size fits the work area.
    let (width, height, _, _, _) = capture(window)?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    Ok(SavedSize {
        width,
        height,
        maximized: false,
        placement: Some(Placement {
            x: position.x,
            y: position.y,
        }),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn shown_frame_change_restores_requested_client_before_maximize() {
        use std::cell::Cell;
        for maximized in [false, true] {
            let visible = Cell::new(false);
            let maximized_native = Cell::new(false);
            let placements = Cell::new(0);
            let requested = SavedSize {
                width: 1000.,
                height: 700.,
                maximized,
                placement: Some(Placement {
                    x: 1_000_000,
                    y: 1_000_000,
                }),
            };
            let actual = Cell::new(SavedSize::default());
            let monitor = MonitorArea {
                x: 2560,
                y: 352,
                width: 1920.,
                height: 1032.,
                scale: 1.,
            };
            let restored = restore_with_visibility(
                Some(requested),
                |normal| {
                    assert!(!normal.maximized);
                    let frame_height = if visible.get() { 9. } else { 39. };
                    let plan = placement_plan(Some(normal), &[monitor], (16., frame_height))?;
                    // Locked Tao adds the hidden shadow-frame offset to the size;
                    // after show the actual frame is 30px shorter, inflating client.
                    actual.set(SavedSize {
                        height: plan.saved.height + if visible.get() { 0. } else { 30. },
                        ..plan.saved
                    });
                    placements.set(placements.get() + 1);
                    Ok(plan.saved)
                },
                || {
                    visible.set(true);
                    Ok(())
                },
                || {
                    assert!(
                        visible.get(),
                        "Maximize must wait for visible normal correction"
                    );
                    assert_eq!(
                        actual.get().height,
                        700.,
                        "Maximize must retain corrected normal client height"
                    );
                    maximized_native.set(true);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                actual.get().height,
                700.,
                "Shown frame must not inflate the requested client height"
            );
            assert_eq!(actual.get().width, 1000.);
            assert_eq!(actual.get().placement, Some(Placement { x: 3464, y: 675 }));
            assert_eq!(
                placements.get(),
                2,
                "One bounded visible correction follows hidden placement"
            );
            assert_eq!(
                restored,
                SavedSize {
                    maximized,
                    ..actual.get()
                }
            );
            assert_eq!(maximized_native.get(), maximized);
        }
    }

    #[test]
    fn fractional_dpi_full_work_area_has_nonnegative_travel_and_fits_physical_frame() {
        for (x, y) in [(0, 0), (-3840, -2160)] {
            let monitor = MonitorArea {
                x,
                y,
                width: 3840.,
                height: 3840.,
                scale: 1.75,
            };
            let saved = SavedSize {
                width: 3000.,
                height: 3000.,
                maximized: false,
                placement: Some(Placement {
                    x: x + 100,
                    y: y + 100,
                }),
            };
            let plan = placement_plan(Some(saved), &[monitor], (16., 16.)).unwrap();
            assert_eq!(plan.saved.placement, Some(Placement { x, y }));
            assert!((plan.saved.width * monitor.scale).round() + 16. <= monitor.width);
            assert!((plan.saved.height * monitor.scale).round() + 16. <= monitor.height);
        }
    }
    #[test]
    fn fractional_physical_frame_and_position_rounding_stay_inside_work_area() {
        let monitor = MonitorArea {
            x: -1920,
            y: 40,
            width: 1920.,
            height: 1080.,
            scale: 1.75,
        };
        let saved = SavedSize {
            width: 1000.4,
            height: 700.,
            maximized: false,
            placement: Some(Placement { x: 0, y: 1000 }),
        };
        let plan = placement_plan(Some(saved), &[monitor], (16.75, 40.75)).unwrap();
        let p = plan.saved.placement.unwrap();
        assert!(p.x as f64 + (plan.saved.width * monitor.scale).round() + 16.75 <= 0.);
        assert!(p.y as f64 + (plan.saved.height * monitor.scale).round() + 40.75 <= 1120.);
    }
    #[test]
    fn placement_events_preserve_normal_geometry_and_main_ownership() {
        let mut s = Session::default();
        s.activate();
        s.begin_restore();
        let normal = Placement { x: -1700, y: 70 };
        assert!(!s.observe_placement("main", normal, 950., 700., false, false, false));
        assert!(!s.is_dirty());
        s.finish_restore();
        assert!(s.observe_placement("main", normal, 950., 700., false, false, false));
        let original = s.pending(false).unwrap().0;
        for (label, max, min, full) in [
            ("secondary", false, false, false),
            ("main", false, true, false),
            ("main", false, false, true),
        ] {
            s.observe_placement(
                label,
                Placement { x: 0, y: 0 },
                2000.,
                1200.,
                max,
                min,
                full,
            );
            assert_eq!(s.pending(false).unwrap().0, original);
        }
        s.observe_placement(
            "main",
            Placement { x: 0, y: 0 },
            2000.,
            1200.,
            true,
            false,
            false,
        );
        let max = s.pending(false).unwrap().0;
        assert_eq!(max.placement, Some(normal));
        assert_eq!((max.width, max.height), (950., 700.));
        assert!(max.maximized);
        s.observe_placement("main", normal, 950., 700., false, false, false);
        assert_eq!(s.pending(false).unwrap().0, original);
    }
    #[test]
    fn invalid_frame_metrics_are_rejected() {
        let monitors = [MonitorArea {
            x: 0,
            y: 0,
            width: 1920.,
            height: 1080.,
            scale: 1.,
        }];
        assert!(placement_plan(None, &monitors, (-1., 20.)).is_err());
    }
    #[test]
    fn monitor_rearrangement_selects_nearest_current_work_area() {
        let saved = SavedSize {
            placement: Some(Placement { x: 2000, y: 30 }),
            ..SavedSize::default()
        };
        let m = [
            MonitorArea {
                x: -1920,
                y: 0,
                width: 1920.,
                height: 1080.,
                scale: 1.,
            },
            MonitorArea {
                x: 0,
                y: 0,
                width: 1920.,
                height: 1080.,
                scale: 1.,
            },
        ];
        let plan = placement_plan(Some(saved), &m, (16., 40.)).unwrap();
        assert_eq!(plan.saved.placement, Some(Placement { x: 724, y: 30 }));
    }
    #[test]
    fn size_only_schema_migrates_and_placement_restores_on_negative_monitor() {
        let old: SavedSize =
            serde_json::from_str(r#"{"width":1000,"height":700,"maximized":false}"#).unwrap();
        assert_eq!(old.placement, None);
        let monitor = MonitorArea {
            x: -1920,
            y: 0,
            width: 1920.,
            height: 1080.,
            scale: 1.,
        };
        let saved = SavedSize {
            placement: Some(Placement { x: -1800, y: 50 }),
            ..old
        };
        let plan = placement_plan(Some(saved), &[monitor], (16., 40.)).unwrap();
        assert_eq!(plan.saved.placement, saved.placement);
    }
    #[test]
    fn lost_monitor_and_scale_change_clamp_complete_frame() {
        let saved = SavedSize {
            width: 1800.,
            height: 1000.,
            maximized: true,
            placement: Some(Placement { x: -1800, y: 100 }),
        };
        let plan = placement_plan(
            Some(saved),
            &[MonitorArea {
                x: 0,
                y: 40,
                width: 1920.,
                height: 1040.,
                scale: 2.,
            }],
            (32., 80.),
        )
        .unwrap();
        assert_eq!((plan.saved.width, plan.saved.height), (944., 480.));
        assert_eq!(plan.saved.placement, Some(Placement { x: 0, y: 40 }));
        assert!(plan.saved.maximized);
    }
    use super::*;
    #[test]
    fn restore_clamps_logical_size_and_uses_small_work_area_instead_of_unusable_minimum() {
        let saved = SavedSize {
            width: 2400.,
            height: 1600.,
            maximized: true,
            placement: None,
        };
        let plan = restore_plan(Some(saved), 1280., 720.).unwrap();
        assert_eq!((plan.saved.width, plan.saved.height), (1280., 720.));
        assert!(plan.saved.maximized);
        let small = restore_plan(Some(saved), 640., 480.).unwrap();
        assert_eq!(
            (
                small.saved.width,
                small.saved.height,
                small.min_width,
                small.min_height
            ),
            (640., 480., 640., 480.)
        );
        let tiny = restore_plan(
            Some(SavedSize {
                width: 10.,
                height: 10.,
                maximized: false,
                placement: None,
            }),
            1920.,
            1080.,
        )
        .unwrap();
        assert_eq!((tiny.saved.width, tiny.saved.height), (800., 650.));
        assert!(restore_plan(None, 0., 1080.).is_err());
        assert!(restore_plan(None, f64::NAN, 1080.).is_err());
    }
    #[test]
    fn logical_restore_is_independent_of_monitor_pixel_density() {
        let saved = SavedSize {
            width: 1000.,
            height: 700.,
            maximized: false,
            placement: None,
        };
        for scale in [1., 1.25, 1.5, 2.] {
            let result =
                restore_plan(Some(saved), 1920. * scale / scale, 1080. * scale / scale).unwrap();
            assert_eq!(result.saved, saved);
        }
    }
    #[test]
    fn only_loaded_main_changes_size_and_maximized_retains_normal_dimensions() {
        let mut session = Session::default();
        assert!(!session.observe("main", 900., 700., false, false, false));
        session.activate();
        assert!(!session.observe("secondary", 900., 700., false, false, false));
        assert!(!session.is_dirty());
        assert!(session.observe("main", 900., 700., false, false, false));
        let (_, first) = session.pending(false).unwrap();
        assert!(!session.observe("main", 1920., 1080., true, false, false));
        let (maximized, second) = session.pending(false).unwrap();
        assert_eq!(
            (maximized.width, maximized.height, maximized.maximized),
            (900., 700., true)
        );
        session.acknowledge(first);
        assert!(session.is_dirty());
        session.acknowledge(second);
        assert!(!session.is_dirty());
        session.stop_worker();
        assert!(!session.observe("main", 0., 0., false, true, false));
        assert!(!session.observe("main", 1920., 1080., false, false, true));
        assert!(!session.is_dirty());
        assert!(session.observe("main", 900., 700., false, false, false));
        assert!(!session.pending(false).unwrap().0.maximized);
    }
    #[test]
    fn malformed_saved_size_falls_back_and_never_persists_runtime_zero_or_nonfinite() {
        let invalid = SavedSize {
            width: f64::NAN,
            height: 10.,
            maximized: false,
            placement: None,
        };
        assert!(invalid.validate().is_err());
        assert_eq!(
            restore_plan(Some(invalid), 1920., 1080.).unwrap().saved,
            SavedSize::default()
        );
        let mut session = Session::default();
        session.activate();
        assert!(!session.observe("main", 0., 700., false, false, false));
        assert!(!session.observe("main", f64::INFINITY, 700., false, false, false));
        assert!(!session.is_dirty());
    }
}
