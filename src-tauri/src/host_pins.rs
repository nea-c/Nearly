use crate::{host_verification, sftp};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinLedger {
    pub version: u32,
    #[serde(deserialize_with = "unique_pins")]
    pub pins: BTreeMap<String, String>,
}
fn unique_pins<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique endpoint pins")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut pins = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if pins.len() >= 4096 || pins.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom(
                        "Duplicate or excess endpoint pins",
                    ));
                }
            }
            Ok(pins)
        }
    }
    deserializer.deserialize_map(Unique)
}
impl Default for PinLedger {
    fn default() -> Self {
        Self {
            version: 1,
            pins: BTreeMap::new(),
        }
    }
}
impl PinLedger {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.pins.len() > 4096 {
            return Err("Host pin ledger version/count invalid".into());
        }
        for (key, pin) in &self.pins {
            let (host, port): (String, u16) =
                serde_json::from_str(key).map_err(|_| "Host pin ledger endpoint invalid")?;
            let p = sftp::Profile {
                id: "ledger".into(),
                name: "ledger".into(),
                host,
                port,
                user: "ledger".into(),
                auth: "key".into(),
                mode: "sftp".into(),
                key_file: String::new(),
                host_key: pin.clone(),
            };
            if host_verification::endpoint(&p)? != *key || sftp::canonical_fingerprint(pin)? != *pin
            {
                return Err("Host pin ledger is not canonical".into());
            }
        }
        Ok(())
    }
    pub fn known(&self, profile: &sftp::Profile) -> Result<Option<&str>, String> {
        if profile.mode != "sftp" {
            return Ok(None);
        }
        Ok(self
            .pins
            .get(&host_verification::endpoint(profile)?)
            .map(String::as_str))
    }
    #[cfg(test)]
    pub fn seed(&mut self, profiles: &[sftp::Profile]) -> Result<(), String> {
        for p in profiles {
            if p.mode == "sftp" && !p.host_key.trim().is_empty() {
                self.insert(p)?;
            }
        }
        Ok(())
    }
    fn insert(&mut self, p: &sftp::Profile) -> Result<(), String> {
        let key = host_verification::endpoint(p)?;
        let pin = sftp::canonical_fingerprint(&p.host_key)?;
        if let Some(old) = self.pins.get(&key) {
            if old != &pin {
                return Err("Known endpoint host key differs; initial approval cannot rotate an existing pin".into());
            }
        } else {
            if self.pins.len() >= 4096 {
                return Err(
                    "Host pin ledger is full; remembered trust is never pruned automatically"
                        .into(),
                );
            }
            self.pins.insert(key, pin);
        }
        Ok(())
    }
    pub fn accept_incoming(&mut self, profiles: &[sftp::Profile]) -> Result<(), String> {
        for p in profiles {
            if p.mode != "sftp" {
                continue;
            }
            let known = self.known(p)?;
            if known.is_some() && p.host_key.trim().is_empty() {
                return Err("A known endpoint pin cannot be cleared; host key rotation requires a separate trust decision".into());
            }
            if !p.host_key.trim().is_empty() {
                self.insert(p)?;
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn hydrate(&self, profiles: &mut [sftp::Profile]) -> Result<(), String> {
        for p in profiles {
            if let Some(pin) = self.known(p)? {
                let pin = pin.to_owned();
                if p.host_key.trim().is_empty() {
                    p.host_key = pin;
                } else if sftp::canonical_fingerprint(&p.host_key)? != pin {
                    return Err("Saved profile conflicts with its remembered endpoint pin".into());
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn p(id: &str, key: &str) -> sftp::Profile {
        sftp::Profile {
            id: id.into(),
            name: id.into(),
            host: "Example.INVALID".into(),
            port: 22,
            user: id.into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: "generated.ppk".into(),
            host_key: key.into(),
        }
    }
    fn pin() -> String {
        format!("SHA256:{}", "A".repeat(43))
    }
    #[test]
    fn endpoint_pins_survive_profile_deletion_renaming_and_clearing_attempts() {
        let mut l = PinLedger::default();
        let trusted = p("a", &pin());
        l.seed(&[trusted.clone()]).unwrap();
        l.accept_incoming(&[]).unwrap();
        assert!(l.accept_incoming(&[p("new-id", "")]).is_err());
        let mut changed = p("another-user", &format!("SHA256:{}", "B".repeat(42) + "A"));
        assert!(l.accept_incoming(&[changed.clone()]).is_err());
        changed.host = "new.invalid".into();
        l.accept_incoming(&[changed]).unwrap();
        assert_eq!(l.pins.len(), 2);
        let mut blank = p("a", "");
        l.hydrate(std::slice::from_mut(&mut blank)).unwrap();
        assert_eq!(blank.host_key, pin());
    }
    #[test]
    fn invalid_ledger_and_capacity_never_silently_reset_or_prune_trust() {
        let mut l = PinLedger::default();
        for i in 0..4096 {
            let mut profile = p("x", &pin());
            profile.host = format!("generated-{i}.invalid");
            l.seed(&[profile]).unwrap();
        }
        assert!(l.accept_incoming(&[p("new", &pin())]).is_err());
        assert_eq!(l.pins.len(), 4096);
        let mut bad = PinLedger::default();
        bad.pins.insert("not-json".into(), pin());
        assert!(bad.validate().is_err());
        assert!(
            serde_json::from_str::<PinLedger>(r#"{"version":1,"pins":{},"secret":"refused"}"#)
                .is_err()
        );
    }
}
