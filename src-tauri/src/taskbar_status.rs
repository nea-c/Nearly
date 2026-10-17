#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeSyncState {
    #[default]
    Scanning,
    Working,
    CaughtUp,
    Error,
    Stopping,
    Stopped,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskbarState { Idle, Working, CaughtUp, Error }
pub fn aggregate(states: impl IntoIterator<Item = NativeSyncState>, starts_pending: bool) -> TaskbarState {
    let mut working = starts_pending;
    let mut caught_up = false;
    for state in states {
        match state {
            NativeSyncState::Error => return TaskbarState::Error,
            NativeSyncState::Scanning | NativeSyncState::Working | NativeSyncState::Stopping => working = true,
            NativeSyncState::CaughtUp => caught_up = true,
            NativeSyncState::Stopped => (),
        }
    }
    if working { TaskbarState::Working }
    else if caught_up { TaskbarState::CaughtUp }
    else { TaskbarState::Idle }
}
#[cfg(test)]
mod tests {
    use super::{aggregate, NativeSyncState::*, TaskbarState as T};
    #[test]
    fn no_jobs_and_only_stopped_jobs_are_idle() {
        assert_eq!(aggregate([], false), T::Idle);
        assert_eq!(aggregate([Stopped, Stopped], false), T::Idle);
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
        let expected = [T::Error, T::Working, T::CaughtUp, T::Working, T::Working, T::Idle, T::Working];
        for (phase, expected) in sequence.into_iter().zip(expected) {
            assert_eq!(aggregate([phase], false), expected);
        }
    }
}



#[cfg(test)]
mod activity_tests {
 use super::*;
 #[test] fn scanning_empty_queue_is_not_completion(){let mut a=Activity::new();a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Scanning);}
 #[test] fn scan_then_idle_is_caught_up_and_new_work_revokes_it(){let mut a=Activity::new();a.scan_finished();a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::CaughtUp);a.mark_working();assert_eq!(a.phase(),NativeSyncState::Working);}
 #[test] fn in_flight_and_undrained_events_never_complete(){let mut a=Activity::new();a.scan_finished();for (pending,drained,flight)in [(1,true,false),(0,false,false),(0,true,true)]{a.settle(pending,drained,flight,false,false);assert_ne!(a.phase(),NativeSyncState::CaughtUp);}}
 #[test] fn partial_failure_stays_error_until_all_work_recovers(){let mut a=Activity::new();a.scan_finished();a.failure(false);a.mark_working();a.settle(1,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Error);a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::CaughtUp);}
 #[test] fn unrecoverable_or_blocked_failure_never_completes(){for hard in [false,true]{let mut a=Activity::new();a.scan_finished();a.failure(hard);a.settle(0,true,false,false,!hard);assert_eq!(a.phase(),NativeSyncState::Error);if hard {a.settle(0,true,false,false,false);assert_eq!(a.phase(),NativeSyncState::Error);}}}
 #[test] fn stopping_and_stopped_are_not_success(){let mut a=Activity::new();a.scan_finished();a.settle(0,true,false,true,false);assert_eq!(a.phase(),NativeSyncState::Stopping);a.stopped();assert_eq!(a.phase(),NativeSyncState::Stopped);}
}

/// Worker-owned current activity. Historic error metrics remain separate.
#[derive(Clone, Debug)]
pub struct Activity { phase: NativeSyncState, scanned: bool, current_error: bool, hard_error: bool }
impl Activity {
 pub fn new()->Self {Self{phase:NativeSyncState::Scanning,scanned:false,current_error:false,hard_error:false}}
 pub fn phase(&self)->NativeSyncState {self.phase}
 pub fn scan_finished(&mut self){self.scanned=true;}
 pub fn mark_working(&mut self){if !matches!(self.phase,NativeSyncState::Error|NativeSyncState::Stopping|NativeSyncState::Stopped){self.phase=NativeSyncState::Working;}}
 pub fn failure(&mut self,hard:bool){self.current_error=true;self.hard_error|=hard;self.phase=NativeSyncState::Error;}
 pub fn stopped(&mut self){self.phase=NativeSyncState::Stopped;}
 pub fn settle(&mut self,pending:usize,events_drained:bool,in_flight:bool,stopping:bool,blocked:bool){
  self.phase=if stopping {NativeSyncState::Stopping}
   else if blocked||self.hard_error {NativeSyncState::Error}
   else if !self.scanned {NativeSyncState::Scanning}
   else if pending>0||!events_drained||in_flight {if self.current_error {NativeSyncState::Error}else{NativeSyncState::Working}}
   else {self.current_error=false;NativeSyncState::CaughtUp};
 }
}
