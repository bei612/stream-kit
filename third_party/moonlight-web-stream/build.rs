use std::env;

fn release_version(upstream: &str, commit: Option<&str>, dirty: Option<&str>) -> String {
    match (commit, dirty) {
        (None, None) => format!("{upstream} (source: unversioned-development)"),
        (Some(commit), Some(dirty @ ("false" | "true")))
            if commit.len() == 40
                && commit
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) =>
        {
            format!("{upstream} (commit: {commit}, dirty: {dirty})")
        }
        _ => panic!(
            "Source stamp requires a lowercase full Git commit and explicit true/false dirty state"
        ),
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=STREAM_KIT_SOURCE_COMMIT");
    println!("cargo:rerun-if-env-changed=STREAM_KIT_SOURCE_DIRTY");
    let version = release_version(
        &env::var("CARGO_PKG_VERSION").expect("package version"),
        env::var("STREAM_KIT_SOURCE_COMMIT").ok().as_deref(),
        env::var("STREAM_KIT_SOURCE_DIRTY").ok().as_deref(),
    );
    println!("cargo:rustc-env=STREAM_KIT_BUILD_VERSION={version}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unstamped_build_cannot_look_like_a_release() {
        assert!(release_version("3.0.1", None, None).contains("unversioned-development"));
    }

    #[test]
    fn stamp_preserves_revision_and_dirty_state() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        for dirty in ["true", "false"] {
            assert_eq!(
                release_version("3.0.1", Some(commit), Some(dirty)),
                format!("3.0.1 (commit: {commit}, dirty: {dirty})")
            );
        }
    }

    #[test]
    fn rejects_incomplete_or_invalid_stamps() {
        for (commit, dirty) in [
            (Some("abc"), Some("false")),
            (None, Some("false")),
            (Some("0123456789abcdef0123456789abcdef01234567"), None),
            (
                Some("0123456789abcdef0123456789abcdef01234567"),
                Some("unknown"),
            ),
        ] {
            assert!(std::panic::catch_unwind(|| release_version("3.0.1", commit, dirty)).is_err());
        }
    }
}
