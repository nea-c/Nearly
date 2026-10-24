//! Public rX.Y tags map one-to-one to stable internal X.Y.0 versions.
//! Stable updater tags remain strict. Distribution prereleases are separately parsed.
pub fn release_version(tag: &str) -> Option<semver::Version> {
    let mut parts = tag.strip_prefix('r')?.split('.');
    let major = component(parts.next()?)?;
    let minor = component(parts.next()?)?;
    if parts.next().is_some() { return None; }
    Some(semver::Version::new(major, minor, 0))
}
pub fn distribution_version(tag: &str) -> Option<semver::Version> {
    if let Some((base,n))=tag.split_once("-pre.") {
        let number=component(n)?;if number==0{return None;}
        let mut v=release_version(base)?;v.pre=semver::Prerelease::new(&format!("pre.{number}")).ok()?;Some(v)
    }else{release_version(tag)}
}
pub fn display_label(version: &semver::Version) -> String {
    let suffix=if version.pre.is_empty(){String::new()}else{format!("-{}",version.pre)};
    format!("r{}.{}{suffix}",version.major,version.minor)
}
fn component(value: &str) -> Option<u64> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) || !value.bytes().all(|c| c.is_ascii_digit()) { return None; }
    let number = value.parse::<u64>().ok()?;
    (number <= 65535).then_some(number)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prerelease_is_distribution_only_and_stable_follows_it() {
        let pre=distribution_version("r3.7-pre.1").unwrap();
        assert_eq!(pre.to_string(),"3.7.0-pre.1");assert_eq!(display_label(&pre),"r3.7-pre.1");
        assert!(release_version("r3.7-pre.1").is_none());assert!(pre<release_version("r3.7").unwrap());
        for invalid in ["r3.7-pre.0","r3.7-pre.01","r3.7-pre.65536","r3.7-pre.1+build","r3.7-beta.1"]{assert!(distribution_version(invalid).is_none());}
    }
    #[test]
    fn public_tags_are_canonical_and_order_numerically() {
        assert_eq!(release_version("r1.0").unwrap().to_string(), "1.0.0");
        for tag in ["r1.0", "r1.10", "r2.0", "r3.0", "r3.1"] {
            assert_eq!(display_label(&release_version(tag).unwrap()), tag);
        }
        assert!(release_version("r1.10") > release_version("r1.9"));
        assert!(release_version("r2.0") > release_version("r1.10"));
        assert_eq!(release_version("r3.1").unwrap().to_string(), "3.1.0");
        assert!(release_version("r3.1") > release_version("r3.0"));
        for invalid in ["v1.0.0", "1.0.0", "r1.0.0", "r01.0", "r1.00", "r1.0-beta", "r1.0+build", "r1.0/asset", "r65536.0", "r-1.0", "r1.0\n"] {
            assert!(release_version(invalid).is_none(), "{invalid}");
        }
    }
}
