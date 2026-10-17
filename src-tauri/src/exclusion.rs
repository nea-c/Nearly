use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::{Component, Path, PathBuf};

/// A job owns this compiled snapshot. Only caller-supplied lines are read;
/// project/global gitignore files and Git configuration are never consulted.
#[derive(Debug)]
pub struct Rules {
    matcher: Gitignore,
}

impl Rules {
    pub fn compile(text: &str) -> Result<Self, String> {
        if text.len() > 65536 || text.contains('\0') {
            return Err(
                "Exclusion rules must be at most 64 KiB and contain no NUL characters".into(),
            );
        }
        let mut builder = GitignoreBuilder::new("");
        builder.allow_unclosed_class(false);
        // Preserve Git's case-sensitive pattern semantics on Windows too.
        for (index, line) in text.lines().enumerate() {
            if index >= 2048 || line.len() > 4096 {
                return Err(
                    "Exclusion rules allow at most 2048 lines and 4096 bytes per line".into(),
                );
            }
            builder.add_line(None, line).map_err(|error| {
                format!("Invalid exclusion rule on line {}: {error}", index + 1)
            })?;
        }
        Ok(Self {
            matcher: builder
                .build()
                .map_err(|error| format!("Invalid exclusion rules: {error}"))?,
        })
    }

    /// Check ancestors top-down as traversal would. The parser's child-first
    /// helper alone lets a negated child bypass an excluded parent, unlike Git.
    pub fn excludes(&self, relative: &Path, is_dir: bool) -> Result<bool, String> {
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err("Exclusion candidate must stay relative to its sync root".into());
        }
        let mut prefix = PathBuf::new();
        let mut parts = relative
            .components()
            .filter(|part| matches!(part, Component::Normal(_)))
            .peekable();
        while let Some(part) = parts.next() {
            prefix.push(part.as_os_str());
            let directory = parts.peek().is_some() || is_dir;
            if self
                .matcher
                .matched_path_or_any_parents(&prefix, directory)
                .is_ignore()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn git_patterns_cover_root_directories_globs_negation_and_unicode() {
        let rules = Rules::compile("# app rules\n/root.txt\ncache/\n*.tmp\nlogs/**/trace?.txt\n!keep.tmp\n資料/秘密*\n\\#literal\n\\!literal\nspace\\ \n").unwrap();
        for (path, directory, excluded) in [
            ("root.txt", false, true),
            ("nested/root.txt", false, false),
            ("cache", true, true),
            ("cache", false, false),
            ("nested/cache/file", false, true),
            ("a/b/file.tmp", false, true),
            ("keep.tmp", false, false),
            ("logs/trace1.txt", false, true),
            ("logs/deep/traceX.txt", false, true),
            ("logs/deep/traceXX.txt", false, false),
            ("資料/秘密メモ.txt", false, true),
            ("#literal", false, true),
            ("!literal", false, true),
            ("space ", false, true),
            ("ordinary.txt", false, false),
        ] {
            assert_eq!(
                rules.excludes(Path::new(path), directory).unwrap(),
                excluded,
                "{path}"
            );
        }
    }

    #[test]
    fn excluded_parent_cannot_be_reopened_by_only_a_child_negation() {
        let rules = Rules::compile("blocked/\n!blocked/keep.txt\n").unwrap();
        assert!(rules
            .excludes(Path::new("blocked/keep.txt"), false)
            .unwrap());
        let reopened =
            Rules::compile("blocked/\n!blocked/\nblocked/*\n!blocked/keep.txt\n").unwrap();
        assert!(!reopened
            .excludes(Path::new("blocked/keep.txt"), false)
            .unwrap());
        assert!(reopened
            .excludes(Path::new("blocked/other.txt"), false)
            .unwrap());
        let deep = Rules::compile("a/\n!a/b/\n!a/b/keep.txt\n").unwrap();
        assert!(deep.excludes(Path::new("a/b/keep.txt"), false).unwrap());
    }

    #[test]
    fn bounds_and_invalid_patterns_fail_before_partial_matching() {
        assert!(Rules::compile("valid\n[broken\n")
            .unwrap_err()
            .contains("line 2"));
        assert!(Rules::compile(&"x".repeat(4097)).is_err());
        assert!(Rules::compile(&"#\n".repeat(2049)).is_err());
        assert!(Rules::compile(&format!("{}\0", "x")).is_err());
        assert!(Rules::compile(&"x".repeat(65537)).is_err());
        let rules = Rules::compile("").unwrap();
        assert!(rules.excludes(Path::new("../outside"), false).is_err());
        assert!(rules.excludes(Path::new("C:\\outside"), false).is_err());
        assert!(!rules.excludes(Path::new(""), true).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_separators_use_the_same_root_relative_rules() {
        let rules = Rules::compile("cache/\n資料/*.tmp\n").unwrap();
        assert!(rules
            .excludes(Path::new(r"nested\cache\file.txt"), false)
            .unwrap());
        assert!(rules.excludes(Path::new(r"資料\秘密.tmp"), false).unwrap());
        assert!(rules.excludes(Path::new(r"\outside"), false).is_err());
    }
}
