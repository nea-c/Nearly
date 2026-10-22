//! Candidate selection only. This type contains no deletion/mutation authority.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ListingHint {
    size: u64,
    mtime: Option<u32>,
    session: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Candidate { ListedUnchanged, FreshComparison, SourceChanged }
/// A comparison baseline, never a permit to mutate. Construct only after the
/// complete inventory and local-root validation. Hints cannot produce this type.
#[derive(Clone)]
pub(crate) struct ListingBaseline<T> { stamp:T, session:u64 }
#[derive(Clone)]
pub(crate) enum DeletionBasis<T> { Verified(T), Listed(ListingBaseline<T>), Suspended }
impl<T> DeletionBasis<T> {
    pub(crate) fn listed_after_complete_inventory(stamp:T,session:u64)->Self {
        Self::Listed(ListingBaseline{stamp,session})
    }
    pub(crate) fn expected(&self,session:u64)->Result<&T,&'static str> {
        match self {
            Self::Verified(stamp)=>Ok(stamp),
            Self::Listed(baseline) if baseline.session==session=>Ok(&baseline.stamp),
            _=>Err("Deletion basis unavailable after session change; stop and restart for a complete scan"),
        }
    }
    pub(crate) fn suspend(&mut self){*self=Self::Suspended;}
    pub(crate) fn is_suspended(&self)->bool{matches!(self,Self::Suspended)}
    pub(crate) fn storage_bytes(&self,bytes:impl Fn(&T)->usize)->usize {
        match self{Self::Verified(stamp)=>bytes(stamp),Self::Listed(baseline)=>bytes(&baseline.stamp),Self::Suspended=>0}
    }
}
impl ListingHint {
    pub(crate) fn from_listing(size: u64, mtime: Option<u32>, session: u64) -> Self {
        Self { size, mtime, session }
    }
    pub(crate) fn select(&self, size:u64, mtime:Option<u32>, session:u64, dirty:bool) -> Candidate {
        if !dirty && self.session==session && self.size==size
            && self.mtime.is_some() && self.mtime==mtime {
            Candidate::ListedUnchanged
        } else {
            Candidate::FreshComparison
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The approved contract uses listing A, not an unobserved historical B.
    // No hint conversion or cross-session reuse may manufacture that baseline.
    #[test] fn listing_baseline_is_session_scoped_and_suspension_invalidates_it() {
        let mut basis=DeletionBasis::listed_after_complete_inventory('A',1);
        assert_eq!(basis.expected(1).unwrap(),&'A');assert!(basis.expected(2).is_err());
        basis.suspend();assert!(basis.is_suspended());assert!(basis.expected(1).is_err());assert_eq!(basis.storage_bytes(|_|9),0);
        basis=DeletionBasis::Verified('C');assert_eq!(basis.expected(2).unwrap(),&'C');
        basis.suspend();assert!(basis.expected(2).is_err());
    }
    // Wrong branch: always using fresh comparison retains F*depth remote calls.
    #[test] fn equal_known_metadata_is_a_listing_candidate() {
        let hint=ListingHint::from_listing(12,Some(100),1);
        assert_eq!(hint.select(12,Some(100),1,false),Candidate::ListedUnchanged);
    }
    // Wrong branch: unknown metadata, local dirtiness, or cross-session reuse
    // must not falsely skip a candidate or suppress a source-change resend.
    #[test] fn unknown_changed_dirty_and_other_session_require_fresh_comparison() {
        let hint=ListingHint::from_listing(12,Some(100),1);
        for (size,mtime,session,dirty) in [(13,Some(100),1,false),(12,Some(101),1,false),
            (12,None,1,false),(12,Some(100),2,false),(12,Some(100),1,true)] {
            assert_eq!(hint.select(size,mtime,session,dirty),Candidate::FreshComparison);
        }
        assert_eq!(ListingHint::from_listing(12,None,1).select(12,None,1,false),Candidate::FreshComparison);
    }
}
