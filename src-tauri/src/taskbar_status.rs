#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeSyncState {
    #[default]
    Scanning,
    Working,
    CaughtUp,
    DeletionRescanRequired,
    Error,
    Stopping,
    Stopped,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskbarState { Idle, Working, CaughtUp, Error, Paused }
/// One shared Shell button must not alternate with window iteration order.
/// Active work/errors win; an idle/editor window never clears a live badge.
pub fn group_badge(states:impl IntoIterator<Item=TaskbarState>)->TaskbarState{
 states.into_iter().max_by_key(|s|match s{TaskbarState::Idle=>0,TaskbarState::CaughtUp=>1,TaskbarState::Paused=>2,TaskbarState::Working=>3,TaskbarState::Error=>4}).unwrap_or(TaskbarState::Idle)
}
#[cfg(test)]mod group_tests{
 use super::*;
 #[test]fn shell_group_is_order_independent_and_idle_windows_never_clear_live_badges(){
  use TaskbarState::*;let ordered=[Idle,CaughtUp,Paused,Working,Error];
  assert_eq!(group_badge([]),Idle);
  for (i,a) in ordered.iter().enumerate(){for (j,b) in ordered.iter().enumerate(){let expected=ordered[i.max(j)];assert_eq!(group_badge([*a,*b]),expected);assert_eq!(group_badge([*b,Idle,*a]),expected);}}
 }
 #[test]fn closing_error_or_working_windows_reveals_remaining_state_and_last_close_clears(){
  use TaskbarState::*;
  assert_eq!(group_badge([Error,Working,CaughtUp]),Error);
  assert_eq!(group_badge([Working,CaughtUp]),Working);
  assert_eq!(group_badge([CaughtUp]),CaughtUp);
  assert_eq!(group_badge([Paused,Idle]),Paused);
  assert_eq!(group_badge([Idle]),Idle);
 }
}
pub fn aggregate(states: impl IntoIterator<Item = NativeSyncState>, starts_pending: bool) -> TaskbarState {
    let mut working = starts_pending;
    let mut caught_up = false;
    let mut stopped = false;
    let mut deletion_rescan = false;
    for state in states {
        match state {
            NativeSyncState::Error => return TaskbarState::Error,
            NativeSyncState::Scanning | NativeSyncState::Working | NativeSyncState::Stopping => working = true,
            NativeSyncState::CaughtUp => caught_up = true,
            NativeSyncState::Stopped => stopped = true,
            NativeSyncState::DeletionRescanRequired => deletion_rescan = true,
        }
    }
    if working { TaskbarState::Working }
    else if deletion_rescan { TaskbarState::Paused }
    else if caught_up { TaskbarState::CaughtUp }
    else if stopped { TaskbarState::Paused }
    else { TaskbarState::Idle }
}
#[cfg(test)]
mod tests {
    use super::{aggregate, NativeSyncState::*, TaskbarState as T};
    #[test]
    fn stopped_jobs_have_a_distinct_presentation_without_changing_live_priorities() {
        assert_eq!(aggregate([Stopped], false), T::Paused);
        assert_eq!(aggregate([], false), T::Idle);
        assert_eq!(aggregate([Stopped, Working], false), T::Working);
        assert_eq!(aggregate([Stopped, CaughtUp], false), T::CaughtUp);
        assert_eq!(aggregate([Stopped, Error], false), T::Error);
        assert_eq!(aggregate([Stopped], true), T::Working);
    }
    #[test]
    fn no_jobs_hide_the_badge_and_only_stopped_jobs_show_pause() {
        assert_eq!(aggregate([], false), T::Idle);
        assert_eq!(aggregate([Stopped, Stopped], false), T::Paused);
    }
    #[test]
    fn only_all_live_jobs_caught_up_get_a_checkmark() {
        assert_eq!(aggregate([CaughtUp], false), T::CaughtUp);
        assert_eq!(aggregate([CaughtUp, Stopped, CaughtUp], false), T::CaughtUp);
    }
    #[test]
    fn starting_scanning_inflight_and_stopping_cannot_show_completion() {
        assert_eq!(aggregate([], true), T::Working);
        for phase in [Scanning, Working, Stopping] {
            assert_eq!(aggregate([CaughtUp, phase], false), T::Working);
        }
        assert_eq!(aggregate([CaughtUp], true), T::Working);
    }
    #[test]
    fn partial_failure_overrides_all_other_jobs_and_startup() {
        for phase in [Scanning, Working, CaughtUp, Error, Stopping, Stopped] {
            assert_eq!(aggregate([phase, Error], false), T::Error);
            assert_eq!(aggregate([Error, phase], true), T::Error);
        }
    }
    #[test]
    fn retry_then_caught_up_then_new_work_then_cancel_are_distinct() {
        let sequence = [Error, Working, CaughtUp, Working, Stopping, Stopped, Scanning];
        let expected = [T::Error, T::Working, T::CaughtUp, T::Working, T::Working, T::Paused, T::Working];
        for (phase, expected) in sequence.into_iter().zip(expected) {
            assert_eq!(aggregate([phase], false), expected);
        }
    }
}



#[cfg(test)]
mod activity_tests {
 use super::*;
 #[test] fn completion_epochs_survive_short_cycles_without_a_presentation_poll(){
  let mut a=Activity::new();assert_eq!(a.take_completion(),0);
  a.scan_finished();a.settle(0,true,false,false,false);assert_eq!(a.take_completion(),1);
  a.mark_working();a.applied_change();a.settle(0,true,false,false,false);
  a.mark_working();a.applied_change();a.settle(0,true,false,false,false);
  assert_eq!(a.take_completion(),2);assert_eq!(a.take_completion(),0);
  for _ in 0..10{a.settle(0,true,false,false,false);}assert_eq!(a.take_completion(),0);
 }
 #[test] fn unchanged_watcher_noise_does_not_rearm_completion(){
  let mut a=Activity::new();a.scan_finished();a.settle(0,true,false,false,false);assert_eq!(a.take_completion(),1);
  a.mark_working();a.settle(0,true,false,false,false);assert_eq!(a.take_completion(),0);
  a.applied_change();a.mark_working();a.settle(0,true,false,false,false);assert_eq!(a.take_completion(),1);
 }
 #[test] fn cancellation_failure_and_rescan_do_not_complete(){
  for (stopping,blocked,rescan) in [(true,false,false),(false,true,false),(false,false,true)]{
   let mut a=Activity::new();a.scan_finished();a.applied_change();a.set_deletion_rescan_required(rescan);
   a.settle(0,true,false,stopping,blocked);assert_eq!(a.take_completion(),0);
  }
  let mut a=Activity::new();a.scan_finished();a.failure(true);a.settle(0,true,false,false,false);assert_eq!(a.take_completion(),0);
 }
 #[test] fn deletion_rescan_is_not_completion_or_error_and_does_not_stop_work(){let mut a=Activity::new();a.scan_finished();a.set_deletion_rescan_required(true);a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::DeletionRescanRequired);assert_eq!(aggregate([a.phase(),NativeSyncState::CaughtUp],false),TaskbarState::Paused);a.settle(2,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Working);a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::DeletionRescanRequired);a.settle(0,true,false,true,false);assert_eq!(a.phase(),NativeSyncState::Stopping);a.set_deletion_rescan_required(false);a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::CaughtUp);}
 #[test] fn scanning_empty_queue_is_not_completion(){let mut a=Activity::new();a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Scanning);}
 #[test] fn scan_then_idle_is_caught_up_and_new_work_revokes_it(){let mut a=Activity::new();a.scan_finished();a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::CaughtUp);a.mark_working();assert_eq!(a.phase(),NativeSyncState::Working);}
 #[test] fn in_flight_and_undrained_events_never_complete(){let mut a=Activity::new();a.scan_finished();for (pending,drained,flight)in [(1,true,false),(0,false,false),(0,true,true)]{a.settle(pending,drained,flight,false,false);assert_ne!(a.phase(),NativeSyncState::CaughtUp);}}
 #[test] fn partial_failure_stays_error_until_all_work_recovers(){let mut a=Activity::new();a.scan_finished();a.failure(false);a.mark_working();a.settle(1,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Error);a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::CaughtUp);}
 #[test] fn unrecoverable_or_blocked_failure_never_completes(){for hard in [false,true]{let mut a=Activity::new();a.scan_finished();a.failure(hard);a.settle(0,true,false,false,!hard);assert_eq!(a.phase(),NativeSyncState::Error);if hard {a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Error);}}}
 #[test] fn stopping_and_stopped_are_not_success(){let mut a=Activity::new();a.scan_finished();a.settle(0,true,false,true,false);assert_eq!(a.phase(),NativeSyncState::Stopping);a.stopped();assert_eq!(a.phase(),NativeSyncState::Stopped);}
}

/// Worker-owned current activity. Historic error metrics remain separate.
#[derive(Clone, Debug)]
pub struct Activity {
 phase: NativeSyncState, scanned: bool, current_error: bool, hard_error: bool, deletion_rescan_required: bool,
 // Native-only epochs survive work that starts and finishes between UI polls.
 completion_epoch: u64, acknowledged_epoch: u64, completion_armed: bool,
}
impl Activity {
 pub fn new()->Self {Self{phase:NativeSyncState::Scanning,scanned:false,current_error:false,hard_error:false,deletion_rescan_required:false,completion_epoch:0,acknowledged_epoch:0,completion_armed:true}}
 pub fn applied_change(&mut self){self.completion_armed=true;}
 pub fn take_completion(&mut self)->u64 {
  let pending=self.completion_epoch-self.acknowledged_epoch;
  self.acknowledged_epoch=self.completion_epoch;
  pending
 }
 pub fn set_deletion_rescan_required(&mut self,required:bool){self.deletion_rescan_required=required;}
 pub fn phase(&self)->NativeSyncState {self.phase}
 pub fn scan_finished(&mut self){self.scanned=true;}
 pub fn mark_working(&mut self){if !matches!(self.phase,NativeSyncState::Error|NativeSyncState::Stopping|NativeSyncState::Stopped){self.phase=NativeSyncState::Working;}}
 pub fn failure(&mut self,hard:bool){self.current_error=true;self.hard_error|=hard;self.phase=NativeSyncState::Error;}
 pub fn stopped(&mut self){self.phase=NativeSyncState::Stopped;}
 pub fn settle(&mut self,pending:usize,events_drained:bool,in_flight:bool,stopping:bool,blocked:bool){
  let previous=self.phase;
  self.phase=if stopping {NativeSyncState::Stopping}
   else if blocked||self.hard_error {NativeSyncState::Error}
   else if !self.scanned {NativeSyncState::Scanning}
   else if pending>0||!events_drained||in_flight {if self.current_error {NativeSyncState::Error}else{NativeSyncState::Working}}
   else if self.deletion_rescan_required {NativeSyncState::DeletionRescanRequired}
   else {self.current_error=false;NativeSyncState::CaughtUp};
  if self.phase==NativeSyncState::CaughtUp&&previous!=NativeSyncState::CaughtUp&&self.completion_armed {
   self.completion_epoch=self.completion_epoch.saturating_add(1);
   self.completion_armed=false;
  }
 }
}
