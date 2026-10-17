//! A bounded, process-local tab gesture. Only an OS-delivered native mouse-up
//! commits; DOM coordinates are geometry hints, never drop authorization.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicI32, Ordering}}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Rect { pub x:f64, pub y:f64, pub width:f64, pub height:f64 }
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point { pub x:f64, pub y:f64 }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport { width:f64, height:f64 }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Item { workspace_id:String, rect:Rect }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Geometry { rect:Rect, items:Vec<Item>, viewport:Viewport }
#[derive(Clone)]
struct Strip { geometry:Geometry, updated:Instant, size:(u32,u32) }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct DragStatus { pub drag_id:String, pub source_label:String, pub workspace_id:String, pub phase:String, pub target_label:Option<String>, pub before_id:Option<String>, pub target_index:Option<usize>, pub token:Option<String>, pub reason:Option<String> }
#[derive(Clone)]
struct Gesture { status:DragStatus, token:String, cancelled:Arc<AtomicBool> }
#[derive(Default)]
pub struct Controller { strips:Mutex<HashMap<String,Strip>>, active:Mutex<Option<Gesture>>, history:Mutex<Vec<DragStatus>> }
impl Controller {
    pub fn forget(&self,label:&str){if let Ok(mut s)=self.strips.lock(){s.remove(label);}if let Ok(active)=self.active.lock(){if let Some(g)=active.as_ref(){if g.status.source_label==label{g.cancelled.store(true,Ordering::Release);}}}}
    fn publish(&self,app:&tauri::AppHandle,status:&DragStatus){
        if let Ok(mut active)=self.active.lock(){if let Some(g)=active.as_mut(){if g.status.drag_id==status.drag_id{g.status=status.clone();}}}
        // Every strip receives feedback so an already-open target can show insertion.
        let mut labels:Vec<_>=self.strips.lock().map(|s|s.keys().cloned().collect()).unwrap_or_default();if !labels.contains(&status.source_label){labels.push(status.source_label.clone());}if let Some(target)=status.target_label.as_ref(){if !labels.contains(target){labels.push(target.clone());}}
        for label in labels {if let Some(w)=app.get_webview_window(&label){let _=w.emit("tab-drag",status);}}
    }
    fn finish(&self,app:&tauri::AppHandle,status:DragStatus){self.publish(app,&status);if let Ok(mut h)=self.history.lock(){if h.len()>=64{h.remove(0);}h.push(status);}if let Ok(mut a)=self.active.lock(){*a=None;}}
}
fn valid_rect(r:Rect,v:&Viewport)->bool{[r.x,r.y,r.width,r.height,v.width,v.height].iter().all(|n|n.is_finite())&&v.width>0.0&&v.height>0.0&&v.width<=32768.0&&v.height<=32768.0&&r.width>=0.0&&r.height>0.0&&r.x>=-1.0&&r.y>=-1.0&&r.x+r.width<=v.width+1.0&&r.y+r.height<=v.height+1.0}
impl Rect { fn contains(&self,x:f64,y:f64)->bool{x>=self.x&&x<self.x+self.width&&y>=self.y&&y<self.y+self.height} }
fn insertion(items:&[Item],source:&str,x:f64)->(usize,Option<String>){let filtered:Vec<_>=items.iter().filter(|i|i.workspace_id!=source).collect();let index=filtered.iter().position(|i|x<i.rect.x+i.rect.width/2.0).unwrap_or(filtered.len());(index,filtered.get(index).map(|i|i.workspace_id.clone()))}

#[tauri::command]
pub fn register_tab_strip(window:tauri::WebviewWindow,state:tauri::State<crate::AppState>,geometry:Option<Geometry>)->Result<(),String>{
    let size=window.inner_size().map_err(|_|"Window geometry unavailable")?;
    let registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;registry.registered(window.label())?;
    let mut strips=state.tab_drag.strips.lock().map_err(|_|"Drag geometry lock failed")?;
    let Some(g)=geometry else {strips.remove(window.label());return Ok(());};
    if !valid_rect(g.rect,&g.viewport)||g.items.len()>128||g.items.iter().any(|i|![i.rect.x,i.rect.y,i.rect.width,i.rect.height].iter().all(|n|n.is_finite()&&n.abs()<=32768.0)||i.rect.width<=0.0||i.rect.height<=0.0||registry.owner(window.label(),&i.workspace_id).is_err()){return Err("Invalid tab strip geometry".into());}
    let mut ids=std::collections::HashSet::new();if g.items.iter().any(|i|!ids.insert(i.workspace_id.clone())){return Err("Duplicate tab geometry".into());}
    strips.insert(window.label().into(),Strip{geometry:g,updated:Instant::now(),size:(size.width,size.height)});Ok(())
}
#[tauri::command]
pub fn tab_drag_status(window:tauri::WebviewWindow,state:tauri::State<crate::AppState>,drag_id:String)->Result<DragStatus,String>{
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.registered(window.label())?;
    if let Some(g)=state.tab_drag.active.lock().map_err(|_|"Drag lock failed")?.as_ref(){if g.status.drag_id==drag_id&&g.status.source_label==window.label(){return Ok(g.status.clone());}}
    state.tab_drag.history.lock().map_err(|_|"Drag lock failed")?.iter().rev().find(|s|s.drag_id==drag_id&&s.source_label==window.label()).cloned().ok_or("Unknown drag".into())
}
#[tauri::command]
pub fn cancel_tab_drag(window:tauri::WebviewWindow,state:tauri::State<crate::AppState>,drag_id:Option<String>)->Result<DragStatus,String>{
    let active=state.tab_drag.active.lock().map_err(|_|"Drag lock failed")?;let g=active.as_ref().ok_or("No active drag")?;if g.status.source_label!=window.label()||drag_id.as_ref().is_some_and(|id|id!=&g.status.drag_id){return Err("Drag belongs to another window".into());}g.cancelled.store(true,Ordering::Release);Ok(g.status.clone())
}
#[tauri::command]
pub async fn begin_tab_drag(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,crate::AppState>,workspace_id:String,payload:serde_json::Value,grab:Point,title:String)->Result<DragStatus,String>{
    if !grab.x.is_finite()||!grab.y.is_finite()||grab.x<0.0||grab.y<0.0||grab.x>2000.0||grab.y>200.0||title.len()>1024{return Err("Invalid tab drag".into());}
    #[cfg(not(windows))] {let _=(window,app,state,workspace_id,payload,grab,title);return Err("Native tab dragging is available on Windows".into());}
    #[cfg(windows)] {
        if !native::button_down(){return Err("The physical mouse button is no longer held".into());}
        if !native::is_foreground(&window){return Err("Source window is not active".into());}
        let mut active=state.tab_drag.active.lock().map_err(|_|"Drag lock failed")?;if active.is_some(){return Err("Another tab drag is active".into());}
        let strip=state.tab_drag.strips.lock().map_err(|_|"Drag geometry lock failed")?.get(window.label()).cloned().ok_or("Tab strip geometry unavailable")?;
        let size=window.inner_size().map_err(|_|"Window geometry unavailable")?;
        let item=strip.geometry.items.iter().find(|i|i.workspace_id==workspace_id).ok_or("Dragged tab geometry unavailable")?;
        if strip.updated.elapsed()>Duration::from_millis(1500)||(size.width,size.height)!=strip.size||grab.x>item.rect.width||grab.y>item.rect.height{return Err("Tab strip geometry is stale".into());}
        let transfer={let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;crate::validate_native_transfer(&state,&registry,window.label(),&workspace_id,&payload)?;registry.begin_drag(window.label(),&workspace_id,payload)?};
        let status=DragStatus{drag_id:transfer.token.clone(),source_label:window.label().into(),workspace_id,phase:"dragging".into(),target_label:None,before_id:None,target_index:None,token:None,reason:None};
        let gesture=Gesture{status:status.clone(),token:transfer.token.clone(),cancelled:Arc::new(AtomicBool::new(false))};*active=Some(gesture.clone());drop(active);
        let (send,receive)=std::sync::mpsc::sync_channel(1);let controller=state.tab_drag.clone();
        let worker_app=app.clone();std::thread::Builder::new().name("nearly-tab-drag".into()).spawn(move||native::run(worker_app,controller,gesture,grab,title,send)).map_err(|e|{let _=state.ownership.lock().map(|mut r|r.abort(window.label(),&transfer.token));if let Ok(mut a)=state.tab_drag.active.lock(){*a=None;}format!("Drag worker unavailable: {e}")})?;
        // Worker reports only after both scoped hooks are installed and button state checked.
        match receive.recv_timeout(Duration::from_secs(5)){Ok(Ok(()))=>Ok(status),Ok(Err(e))=>Err(e),Err(_)=>{if let Ok(a)=state.tab_drag.active.lock(){if let Some(g)=a.as_ref(){g.cancelled.store(true,Ordering::Release);}}Err("Native drag did not become ready".into())}}
    }
}

#[cfg(windows)]
mod native {
use super::*;
use windows::Win32::{Foundation::{HWND,HINSTANCE, LPARAM,LRESULT,WPARAM,POINT,RECT},UI::{WindowsAndMessaging::*,Input::KeyboardAndMouse::{GetAsyncKeyState,VK_LBUTTON,VK_ESCAPE}},Graphics::Gdi::{MonitorFromPoint,GetMonitorInfoW,MONITORINFO,MONITOR_DEFAULTTONEAREST},System::LibraryLoader::GetModuleHandleW};
// Only one gesture exists process-wide. Callbacks retain no key history and never swallow input.
static RELEASED:AtomicBool=AtomicBool::new(false);static ESCAPED:AtomicBool=AtomicBool::new(false);static X:AtomicI32=AtomicI32::new(0);static Y:AtomicI32=AtomicI32::new(0);
unsafe extern "system" fn mouse(code:i32,w:WPARAM,l:LPARAM)->LRESULT{if code>=0&&w.0==WM_LBUTTONUP as usize&&!RELEASED.load(Ordering::Acquire){let event=&*(l.0 as *const MSLLHOOKSTRUCT);X.store(event.pt.x,Ordering::Relaxed);Y.store(event.pt.y,Ordering::Relaxed);RELEASED.store(true,Ordering::Release);}CallNextHookEx(None,code,w,l)}
unsafe extern "system" fn keyboard(code:i32,w:WPARAM,l:LPARAM)->LRESULT{if code>=0&&(w.0==WM_KEYDOWN as usize||w.0==WM_SYSKEYDOWN as usize){let event=&*(l.0 as *const KBDLLHOOKSTRUCT);if event.vkCode==VK_ESCAPE.0 as u32{ESCAPED.store(true,Ordering::Release);}}CallNextHookEx(None,code,w,l)}
struct Hooks(HHOOK,HHOOK);impl Drop for Hooks{fn drop(&mut self){unsafe{let _=UnhookWindowsHookEx(self.0);let _=UnhookWindowsHookEx(self.1);}}}
pub fn button_down()->bool{unsafe{GetAsyncKeyState(VK_LBUTTON.0 as i32)<0}}
pub fn is_foreground(w:&tauri::WebviewWindow)->bool{unsafe{w.hwnd().ok().map(|h|h.0)==Some(GetForegroundWindow().0)}}
fn cursor()->Result<POINT,String>{let mut p=POINT::default();unsafe{GetCursorPos(&mut p)}.map_err(|_|"Native cursor unavailable")?;Ok(p)}
fn hooks()->Result<Hooks,String>{unsafe{RELEASED.store(false,Ordering::Release);ESCAPED.store(false,Ordering::Release);let module=GetModuleHandleW(None).map_err(|_|"Native drag module unavailable")?;let instance=Some(HINSTANCE(module.0));let mouse=SetWindowsHookExW(WH_MOUSE_LL,Some(mouse),instance,0).map_err(|_|"Native mouse listener unavailable")?;match SetWindowsHookExW(WH_KEYBOARD_LL,Some(keyboard),instance,0){Ok(keyboard)=>Ok(Hooks(mouse,keyboard)),Err(_)=>{let _=UnhookWindowsHookEx(mouse);Err("Native escape listener unavailable".into())}}}}
fn pump(){unsafe{let mut msg=MSG::default();while PeekMessageW(&mut msg,None,0,0,PM_REMOVE).as_bool(){let _=TranslateMessage(&msg);DispatchMessageW(&msg);}}}
struct Input {stop:Arc<AtomicBool>,thread:Option<std::thread::JoinHandle<()>>}
impl Drop for Input {fn drop(&mut self){self.stop.store(true,Ordering::Release);if let Some(thread)=self.thread.take(){let _=thread.join();}}}
fn input()->Result<Input,String>{
    let stop=Arc::new(AtomicBool::new(false));let stopping=stop.clone();let(send,receive)=std::sync::mpsc::sync_channel(1);
    let thread=std::thread::Builder::new().name("nearly-drag-input".into()).spawn(move||{let hooks=match hooks(){Ok(h)=>h,Err(e)=>{let _=send.send(Err(e));return;}};if !button_down(){let _=send.send(Err("Mouse released before native drag was ready".into()));return;}let began=Instant::now();let _=send.send(Ok(()));while !stopping.load(Ordering::Acquire){if began.elapsed()>Duration::from_secs(60){ESCAPED.store(true,Ordering::Release);break;}pump();std::thread::sleep(Duration::from_millis(3));}drop(hooks);}).map_err(|_|"Native input thread unavailable")?;
    let guard=Input{stop,thread:Some(thread)};receive.recv_timeout(Duration::from_secs(3)).map_err(|_|"Native input thread did not become ready")??;Ok(guard)
}
fn root_at(app:&tauri::AppHandle,p:POINT)->HWND{unsafe{
    let root=GetAncestor(WindowFromPoint(p),GA_ROOT);let ghost=app.get_webview_window("tab-drag-preview").and_then(|w|w.hwnd().ok()).map(|h|h.0);
    if ghost!=Some(root.0){return root;}
    // Some Windows versions include click-through layered windows in
    // WindowFromPoint. Walk actual top-level z-order, skipping only our ghost.
    let mut current=GetTopWindow(None).ok();let mut budget=4096;
    while let Some(w)=current{if budget==0{break;}budget-=1;if ghost!=Some(w.0)&&IsWindowVisible(w).as_bool()&&!IsIconic(w).as_bool(){let mut r=RECT::default();if GetWindowRect(w,&mut r).is_ok()&&p.x>=r.left&&p.x<r.right&&p.y>=r.top&&p.y<r.bottom{return w;}}current=GetWindow(w,GW_HWNDNEXT).ok();}HWND::default()
}}
fn point_in_strip(w:&tauri::WebviewWindow,s:&Strip,p:POINT)->Result<Option<(f64,f64)>,String>{
    if s.updated.elapsed()>Duration::from_millis(1500){return Err("Tab strip geometry expired".into());}let size=w.inner_size().map_err(|_|"Window geometry unavailable")?;if (size.width,size.height)!=s.size{return Err("Tab strip changed size".into());}
    let origin=w.inner_position().map_err(|_|"Window position unavailable")?;let x=(p.x-origin.x) as f64*s.geometry.viewport.width/size.width.max(1) as f64;let y=(p.y-origin.y) as f64*s.geometry.viewport.height/size.height.max(1) as f64;
    Ok(s.geometry.rect.contains(x,y).then_some((x,y)))
}
fn target(app:&tauri::AppHandle,c:&Controller,g:&Gesture,p:POINT)->Result<Option<(String,usize,Option<String>)>,String>{
    let root=root_at(app,p);let strips=c.strips.lock().map_err(|_|"Drag geometry lock failed")?.clone();
    for (label,w) in app.webview_windows(){if label=="tab-drag-preview"{continue;}if w.hwnd().ok().map(|h|h.0)!=Some(root.0){continue;}let Some(s)=strips.get(&label) else{return Err("Target tab strip is unavailable".into());};if let Some((x,_))=point_in_strip(&w,s,p)?{let(index,before)=insertion(&s.geometry.items,&g.status.workspace_id,x);return Ok(Some((label,index,before)));}return Ok(None);}
    Ok(None)
}
pub fn run(app:tauri::AppHandle,controller:Arc<Controller>,g:Gesture,grab:Point,title:String,ready:std::sync::mpsc::SyncSender<Result<(),String>>){
    let mut status=g.status.clone();let result=(||->Result<(),String>{
        // A dedicated hook-only thread is pumping before any WebView/UI work.
        let scoped_input=input()?;cursor()?;let _=ready.send(Ok(()));
        let url=tauri::WebviewUrl::App("drag-preview.html".into());
        let title_script=format!("window.__NEARLY_DRAG_TITLE__={};",serde_json::to_string(&title).map_err(|_|"Invalid drag title")?);
        let preview=tauri::WebviewWindowBuilder::new(&app,"tab-drag-preview",url).initialization_script(&title_script).title(&title).inner_size(220.0,42.0).decorations(false).resizable(false).skip_taskbar(true).always_on_top(true).focused(false).focusable(false).visible(false).build().map_err(|e|format!("Drag preview unavailable: {e}"))?;
        struct Preview(tauri::WebviewWindow);impl Drop for Preview{fn drop(&mut self){let _=self.0.destroy();}}
        let preview=Preview(preview);preview.0.set_ignore_cursor_events(true).map_err(|_|"Drag preview passthrough unavailable")?;
        let initial=cursor()?;let _=preview.0.set_position(tauri::PhysicalPosition::new(initial.x.saturating_add(14),initial.y.saturating_add(18)));let _=preview.0.show();let began=Instant::now();
        let release=loop{
            if g.cancelled.load(Ordering::Acquire)||ESCAPED.load(Ordering::Acquire){return Err("Drag cancelled".into());}
            if began.elapsed()>Duration::from_secs(60){return Err("Drag timed out".into());}
            if RELEASED.load(Ordering::Acquire){break POINT{x:X.load(Ordering::Relaxed),y:Y.load(Ordering::Relaxed)};}
            if !button_down(){return Err("Native mouse release could not be verified".into());}
            let p=cursor()?;if app.get_webview_window(&status.source_label).is_none(){return Err("Source window closed".into());}
            let candidate=target(&app,&controller,&g,p).ok().flatten();status.target_label=candidate.as_ref().map(|t|t.0.clone());status.target_index=candidate.as_ref().map(|t|t.1);status.before_id=candidate.and_then(|t|t.2);controller.publish(&app,&status);
            let scale=preview.0.scale_factor().unwrap_or(1.0);let _=preview.0.set_position(tauri::PhysicalPosition::new(p.x.saturating_add((14.0*scale) as i32),p.y.saturating_add((18.0*scale) as i32)));
            std::thread::sleep(Duration::from_millis(24));
        };
        // No native listeners remain while creating/hydrating application windows.
        drop(scoped_input);drop(preview);
        let destination=target(&app,&controller,&g,release)?;
        if let Some((label,index,before))=destination.as_ref(){if label==&status.source_label{app.state::<crate::AppState>().ownership.lock().map_err(|_|"Ownership lock failed")?.abort(&status.source_label,&g.token)?;status.phase="reordered".into();status.target_label=Some(label.clone());status.target_index=Some(*index);status.before_id=before.clone();return Ok(());}}
        let transfer=crate::stage_drag_transfer(&app,&status.source_label,&g.token,destination,release.x,release.y,grab.x,grab.y)?;
        status.phase="pending".into();status.target_label=Some(transfer.target_label);status.target_index=transfer.target_index;status.before_id=transfer.before_id;status.token=Some(transfer.token);Ok(())
    })();
    if let Err(error)=result{let _=ready.try_send(Err(error.clone()));let _=app.state::<crate::AppState>().ownership.lock().map(|mut r|r.abort(&status.source_label,&g.token));status.phase="cancelled".into();status.target_label=None;status.target_index=None;status.before_id=None;status.reason=Some(error);}
    controller.finish(&app,status);
}
pub fn place(w:&tauri::WebviewWindow,x:i32,y:i32,grab_x:f64,grab_y:f64)->Result<(),String>{
    w.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|_|"Unable to position incoming window")?;
    let scale=w.scale_factor().map_err(|_|"Incoming display scale unavailable")?;let size=w.outer_size().map_err(|_|"Incoming size unavailable")?;
    let mut monitor=MONITORINFO{cbSize:std::mem::size_of::<MONITORINFO>() as u32,..Default::default()};unsafe{if !GetMonitorInfoW(MonitorFromPoint(POINT{x,y},MONITOR_DEFAULTTONEAREST),&mut monitor).as_bool(){return Err("Monitor work area unavailable".into());}}
    let r=monitor.rcWork;let px=clamp_origin(x as f64-grab_x*scale,r.left,r.right,size.width);let py=clamp_origin(y as f64-grab_y*scale,r.top,r.bottom,size.height);
    w.set_position(tauri::PhysicalPosition::new(px,py)).map_err(|_|"Unable to position incoming window".into())
}
}
pub fn clamp_origin(value:f64,min:i32,max:i32,size:u32)->i32{(value.round() as i32).clamp(min,max.saturating_sub(size.min(i32::MAX as u32) as i32).max(min))}
#[cfg(windows)]pub use native::place;

#[cfg(test)]mod tests {use super::*;
#[test]fn clamping_preserves_negative_monitor_coordinates(){assert_eq!(clamp_origin(-1500.0,-1920,0,1180),-1500);assert_eq!(clamp_origin(-10.0,-1920,0,1180),-1180);assert_eq!(clamp_origin(1.0,-800,0,1180),-800);}
#[test]fn insertion_uses_midpoints_and_excludes_moving_tab(){let items=vec![Item{workspace_id:"a".into(),rect:Rect{x:10.,y:0.,width:100.,height:40.}},Item{workspace_id:"b".into(),rect:Rect{x:110.,y:0.,width:100.,height:40.}},Item{workspace_id:"c".into(),rect:Rect{x:210.,y:0.,width:100.,height:40.}}];assert_eq!(insertion(&items,"b",155.),(1,Some("c".into())));assert_eq!(insertion(&items,"z",159.),(1,Some("b".into())));assert_eq!(insertion(&items,"z",500.),(3,None));}
#[test]fn geometry_rejects_nan_and_offscreen_rectangles(){let v=Viewport{width:800.,height:600.};assert!(!valid_rect(Rect{x:f64::NAN,y:0.,width:10.,height:10.},&v));assert!(!valid_rect(Rect{x:790.,y:0.,width:100.,height:40.},&v));}
}
