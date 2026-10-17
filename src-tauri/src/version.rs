//! Public rX.Y tags map one-to-one to stable internal X.Y.0 versions.
//! Patch/build/prerelease aliases are deliberately outside the release policy.
pub fn release_version(tag: &str) -> Option<semver::Version> {
    let mut parts = tag.strip_prefix('r')?.split('.');
    let major = component(parts.next()?)?;
    let minor = component(parts.next()?)?;
    if parts.next().is_some() { return None; }
    Some(semver::Version::new(major, minor, 0))
}
pub fn display_label(version: &semver::Version) -> String {
    format!("r{}.{}", version.major, version.minor)
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
    fn public_tags_are_canonical_and_order_numerically() {
        assert_eq!(release_version("r1.0").unwrap().to_string(), "1.0.0");
        for tag in ["r1.0", "r1.10", "r2.0"] {
            assert_eq!(display_label(&release_version(tag).unwrap()), tag);
        }
        assert!(release_version("r1.10") > release_version("r1.9"));
        assert!(release_version("r2.0") > release_version("r1.10"));
        for invalid in ["v1.0.0", "1.0.0", "r1.0.0", "r01.0", "r1.00", "r1.0-beta", "r1.0+build", "r1.0/asset", "r65536.0", "r-1.0", "r1.0\n"] {
            assert!(release_version(invalid).is_none(), "{invalid}");
        }
    }
}
