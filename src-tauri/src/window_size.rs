//! Native-only main-window size preference. No position or fullscreen state.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub(crate) const SAVE_DELAY: Duration = Duration::from_millis(350);
const DEFAULT_WIDTH:f64=1180.;
const DEFAULT_HEIGHT:f64=850.;
const MIN_WIDTH:f64=800.;
const MIN_HEIGHT:f64=650.;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedSize {pub(crate) width:f64,pub(crate) height:f64,pub(crate) maximized:bool}
impl Default for SavedSize {fn default()->Self{Self{width:DEFAULT_WIDTH,height:DEFAULT_HEIGHT,maximized:false}}}
impl SavedSize {
    pub(crate) fn validate(&self)->Result<(),String>{
        if ![self.width,self.height].iter().all(|n|n.is_finite()&&*n>=1.&&*n<=100_000.){return Err("Invalid saved window size".into())}Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RestorePlan {pub(crate) saved:SavedSize,pub(crate) min_width:f64,pub(crate) min_height:f64}
pub(crate) fn restore_plan(saved:Option<SavedSize>,work_width:f64,work_height:f64)->Result<RestorePlan,String>{
    if ![work_width,work_height].iter().all(|n|n.is_finite()&&*n>=1.){return Err("Monitor work area is unavailable".into())}
    let saved=saved.filter(|s|s.validate().is_ok()).unwrap_or_default();
    let min_width=MIN_WIDTH.min(work_width);let min_height=MIN_HEIGHT.min(work_height);
    Ok(RestorePlan{saved:SavedSize{width:saved.width.clamp(min_width,work_width),height:saved.height.clamp(min_height,work_height),maximized:saved.maximized},min_width,min_height})
}

/// One bounded debounce worker, owned only by the main native window.
#[derive(Default)]
pub(crate) struct Session {ready:bool,last:SavedSize,dirty:bool,generation:u64,changed:Option<Instant>,worker:bool}
impl Session {
    pub(crate) fn seed(&mut self,saved:SavedSize){self.last=saved;}
    pub(crate) fn activate(&mut self){self.ready=true;}
    pub(crate) fn observe(&mut self,label:&str,width:f64,height:f64,maximized:bool,minimized:bool,fullscreen:bool)->bool{
        if label!="main"||!self.ready||minimized||fullscreen{return false}
        let mut next=self.last;
        next.maximized=maximized;
        if !maximized {
            // Quantize subpixel conversion noise without making physical pixels
            // the persisted unit across monitor DPI changes.
            next.width=(width*10.).round()/10.;next.height=(height*10.).round()/10.;
            if next.validate().is_err(){return false}
        }
        if next==self.last{return false}
        self.last=next;self.dirty=true;self.generation=self.generation.wrapping_add(1);self.changed=Some(Instant::now());
        if self.worker{return false}self.worker=true;true
    }
    pub(crate) fn pending(&self,quiet:bool)->Option<(SavedSize,u64)>{
        (self.dirty&&(!quiet||self.changed.is_some_and(|at|at.elapsed()>=SAVE_DELAY))).then_some((self.last,self.generation))
    }
    pub(crate) fn is_dirty(&self)->bool{self.dirty}
    pub(crate) fn acknowledge(&mut self,generation:u64){if self.generation==generation{self.dirty=false;}}
    pub(crate) fn stop_worker(&mut self){self.worker=false;}
}

pub(crate) fn capture(window:&tauri::WebviewWindow)->Result<(f64,f64,bool,bool,bool),String>{
    let scale=window.scale_factor().map_err(|e|e.to_string())?;
    if !scale.is_finite()||scale<=0.{return Err("Invalid window scale factor".into())}
    let size=window.inner_size().map_err(|e|e.to_string())?;
    Ok((size.width as f64/scale,size.height as f64/scale,window.is_maximized().map_err(|e|e.to_string())?,window.is_minimized().map_err(|e|e.to_string())?,window.is_fullscreen().map_err(|e|e.to_string())?))
}

#[cfg(windows)]
fn work_area(window:&tauri::WebviewWindow)->Result<(f64,f64),String>{
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow,GetMonitorInfoW,MONITORINFO,MONITOR_DEFAULTTONEAREST};
    let hwnd=windows::Win32::Foundation::HWND(window.hwnd().map_err(|e|e.to_string())?.0);
    let monitor=unsafe{MonitorFromWindow(hwnd,MONITOR_DEFAULTTONEAREST)};
    let mut info=MONITORINFO{cbSize:std::mem::size_of::<MONITORINFO>() as u32,..Default::default()};
    if !unsafe{GetMonitorInfoW(monitor,&mut info)}.as_bool(){return Err("Monitor work area is unavailable".into())}
    let scale=window.scale_factor().map_err(|e|e.to_string())?;
    if !scale.is_finite()||scale<=0.{return Err("Invalid window scale factor".into())}
    let outer=window.outer_size().map_err(|e|e.to_string())?;let inner=window.inner_size().map_err(|e|e.to_string())?;
    let frame_width=outer.width.saturating_sub(inner.width) as f64;let frame_height=outer.height.saturating_sub(inner.height) as f64;
    Ok((((info.rcWork.right as i64-info.rcWork.left as i64) as f64-frame_width)/scale,((info.rcWork.bottom as i64-info.rcWork.top as i64) as f64-frame_height)/scale))
}
#[cfg(not(windows))]
fn work_area(window:&tauri::WebviewWindow)->Result<(f64,f64),String>{
    let monitor=window.current_monitor().map_err(|e|e.to_string())?.ok_or("Monitor unavailable")?;
    let scale=monitor.scale_factor();let size=monitor.size();Ok((size.width as f64/scale,size.height as f64/scale))
}
pub(crate) fn restore(window:&tauri::WebviewWindow,saved:Option<SavedSize>)->Result<SavedSize,String>{
    let (width,height)=work_area(window)?;let plan=restore_plan(saved,width,height)?;
    window.set_min_size(Some(tauri::LogicalSize::new(plan.min_width,plan.min_height))).map_err(|e|e.to_string())?;
    window.set_size(tauri::LogicalSize::new(plan.saved.width,plan.saved.height)).map_err(|e|e.to_string())?;
    // The last normal size is seeded before maximize; maximized resize events
    // can never replace it with the work area's dimensions.
    if plan.saved.maximized{window.maximize().map_err(|e|e.to_string())?;}
    Ok(plan.saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn restore_clamps_logical_size_and_uses_small_work_area_instead_of_unusable_minimum(){
        let saved=SavedSize{width:2400.,height:1600.,maximized:true};
        let plan=restore_plan(Some(saved),1280.,720.).unwrap();assert_eq!((plan.saved.width,plan.saved.height),(1280.,720.));assert!(plan.saved.maximized);
        let small=restore_plan(Some(saved),640.,480.).unwrap();assert_eq!((small.saved.width,small.saved.height,small.min_width,small.min_height),(640.,480.,640.,480.));
        let tiny=restore_plan(Some(SavedSize{width:10.,height:10.,maximized:false}),1920.,1080.).unwrap();assert_eq!((tiny.saved.width,tiny.saved.height),(800.,650.));
        assert!(restore_plan(None,0.,1080.).is_err());assert!(restore_plan(None,f64::NAN,1080.).is_err());
    }
    #[test]fn logical_restore_is_independent_of_monitor_pixel_density(){
        let saved=SavedSize{width:1000.,height:700.,maximized:false};
        for scale in [1.,1.25,1.5,2.] {let result=restore_plan(Some(saved),1920.*scale/scale,1080.*scale/scale).unwrap();assert_eq!(result.saved,saved);}
    }
    #[test]fn only_loaded_main_changes_size_and_maximized_retains_normal_dimensions(){
        let mut session=Session::default();assert!(!session.observe("main",900.,700.,false,false,false));session.activate();
        assert!(!session.observe("secondary",900.,700.,false,false,false));assert!(!session.is_dirty());
        assert!(session.observe("main",900.,700.,false,false,false));let (_,first)=session.pending(false).unwrap();
        assert!(!session.observe("main",1920.,1080.,true,false,false));let (maximized,second)=session.pending(false).unwrap();
        assert_eq!((maximized.width,maximized.height,maximized.maximized),(900.,700.,true));session.acknowledge(first);assert!(session.is_dirty());
        session.acknowledge(second);assert!(!session.is_dirty());session.stop_worker();
        assert!(!session.observe("main",0.,0.,false,true,false));assert!(!session.observe("main",1920.,1080.,false,false,true));assert!(!session.is_dirty());
        assert!(session.observe("main",900.,700.,false,false,false));assert!(!session.pending(false).unwrap().0.maximized);
    }
    #[test]fn malformed_saved_size_falls_back_and_never_persists_runtime_zero_or_nonfinite(){
        let invalid=SavedSize{width:f64::NAN,height:10.,maximized:false};assert!(invalid.validate().is_err());
        assert_eq!(restore_plan(Some(invalid),1920.,1080.).unwrap().saved,SavedSize::default());
        let mut session=Session::default();session.activate();assert!(!session.observe("main",0.,700.,false,false,false));assert!(!session.observe("main",f64::INFINITY,700.,false,false,false));assert!(!session.is_dirty());
    }
}
