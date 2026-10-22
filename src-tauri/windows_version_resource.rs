//! Transform the generated RC source, never a linked or signed executable.
pub fn display_versions(source: &str, internal: &str, display: &str) -> Result<String, String> {
    let mut changed = source.to_owned();
    for key in ["FileVersion", "ProductVersion"] {
        let original = format!("VALUE \"{key}\", \"{internal}\"");
        // Fail closed when an upstream generator changes its format or adds
        // another translation. Never silently leave a numeric display string.
        if source.matches(&format!("\"{key}\"")).count() != 1
            || source.matches(&original).count() != 1
        {
            return Err(format!(
                "Expected exactly one generated {key} value matching {internal}"
            ));
        }
        changed = changed.replacen(&original, &format!("VALUE \"{key}\", \"{display}\""), 1);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(version: &str) -> String {
        format!(concat!(
            "#pragma code_page(65001)\n1 VERSIONINFO\n",
            "FILEVERSION 3, 2, 0, 0\nPRODUCTVERSION 3, 2, 0, 0\n",
            "{{\nBLOCK \"StringFileInfo\"\n{{\nBLOCK \"000004b0\"\n{{\n",
            "VALUE \"FileDescription\", \"Nearly\"\nVALUE \"FileVersion\", \"{}\"\n",
            "VALUE \"ProductVersion\", \"{}\"\n}}\n}}\n",
            "BLOCK \"VarFileInfo\" {{\nVALUE \"Translation\", 0x0, 0x04b0\n}}\n}}\n",
            "32512 ICON \"C:\\\\fixture\\\\icon.ico\"\n",
            "1 24 {{\n\"<assembly><requestedExecutionLevel level=\"\"asInvoker\"\"/></assembly>\"\n}}\n"
        ), version, version)
    }

    #[test]
    fn changes_only_two_string_values_preserving_all_other_resource_bytes() {
        let source = fixture("3.2.0");
        let changed = display_versions(&source, "3.2.0", "r3.2").unwrap();
        assert!(changed.contains("VALUE \"ProductVersion\", \"r3.2\""));
        assert!(changed.contains("VALUE \"FileVersion\", \"r3.2\""));
        assert_eq!(changed.replace("\"r3.2\"", "\"3.2.0\""), source);
    }

    #[test]
    fn preserves_minor_zero_and_line_endings() {
        let source = fixture("3.0.0").replace('\n', "\r\n");
        let changed = display_versions(&source, "3.0.0", "r3.0").unwrap();
        assert_eq!(changed.matches("\"r3.0\"").count(), 2);
        assert_eq!(changed.replace("\"r3.0\"", "\"3.0.0\""), source);
    }

    #[test]
    fn refuses_missing_duplicate_or_unexpected_version_strings() {
        let source = fixture("3.2.0");
        for altered in [
            source.replace("FileVersion", "OtherVersion"),
            source.replace("3.2.0", "3.1.0"),
            format!("{source}VALUE \"FileVersion\", \"3.2.0\"\n"),
            source.replace(
                "VALUE \"ProductVersion\", \"3.2.0\"",
                "VALUE \"ProductVersion\", \"other\"",
            ),
        ] {
            assert!(display_versions(&altered, "3.2.0", "r3.2").is_err());
        }
    }
}
