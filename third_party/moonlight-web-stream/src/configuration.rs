//! Desired native configuration. Runtime Config remains immutable until restart.
use crate::{cli::CliConfig, config::Config, human_json::preprocess_human_json};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

const LIMIT: u64 = 1024 * 1024;
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native configuration is unavailable")]
    Unavailable,
    #[error("native configuration changed; reload before saving")]
    Conflict,
    #[error("invalid native configuration")]
    Invalid,
}

#[derive(Serialize)]
pub struct View {
    pub revision: String,
    pub running_revision: Option<String>,
    pub restart_required: bool,
    pub apply_policy: &'static str,
    pub values: Value,
    pub redacted_paths: Vec<String>,
    pub overridden_paths: Vec<String>,
}

pub struct Settings {
    path: PathBuf,
    running_revision: Option<String>,
    overrides: CliConfig,
    lock: Mutex<()>,
}

pub fn revision(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

impl Settings {
    pub fn new(path: PathBuf, source: Option<&str>, overrides: CliConfig) -> Self {
        Self {
            path,
            running_revision: source.map(|s| revision(s.as_bytes())),
            overrides,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<(Vec<u8>, Config), Error> {
        let metadata = fs::symlink_metadata(&self.path).map_err(|_| Error::Unavailable)?;
        if !metadata.is_file() || metadata.len() > LIMIT {
            return Err(Error::Unavailable);
        }
        let mut data = Vec::new();
        fs::File::open(&self.path)
            .map_err(|_| Error::Unavailable)?
            .take(LIMIT + 1)
            .read_to_end(&mut data)
            .map_err(|_| Error::Unavailable)?;
        if data.len() as u64 > LIMIT {
            return Err(Error::Unavailable);
        }
        let source = String::from_utf8(data.clone()).map_err(|_| Error::Invalid)?;
        let config =
            serde_json::from_str(&preprocess_human_json(source)).map_err(|_| Error::Invalid)?;
        Ok((data, config))
    }

    fn project(&self, data: &[u8], config: &Config) -> Result<View, Error> {
        let mut values = serde_json::to_value(config).map_err(|_| Error::Invalid)?;
        let mut effective = config.clone();
        self.overrides.clone().apply(&mut effective);
        let effective = serde_json::to_value(effective).map_err(|_| Error::Invalid)?;
        let mut overridden_paths = Vec::new();
        differences(&values, &effective, "", &mut overridden_paths);
        let mut redacted_paths = Vec::new();
        for path in [
            "/web_server/media_ticket_secret",
            "/web_server/certificate",
            "/webrtc/ice_server_script",
        ] {
            redact(&mut values, path, &mut redacted_paths);
        }
        let count = config.webrtc.ice_servers.len();
        for index in 0..count {
            for field in ["credential", "urls"] {
                redact(
                    &mut values,
                    &format!("/webrtc/ice_servers/{index}/{field}"),
                    &mut redacted_paths,
                );
            }
        }
        let rev = revision(data);
        Ok(View {
            running_revision: self.running_revision.clone(),
            restart_required: self.running_revision.as_ref() != Some(&rev),
            revision: rev,
            apply_policy: "gateway_restart",
            values,
            redacted_paths,
            overridden_paths,
        })
    }

    pub fn view(&self) -> Result<View, Error> {
        let _guard = self.lock.lock().map_err(|_| Error::Unavailable)?;
        let (data, config) = self.read()?;
        self.project(&data, &config)
    }

    pub fn save(&self, expected: &str, changes: BTreeMap<String, Value>) -> Result<View, Error> {
        let _guard = self.lock.lock().map_err(|_| Error::Unavailable)?;
        let (data, config) = self.read()?;
        if expected != revision(&data) {
            return Err(Error::Conflict);
        }
        if changes.is_empty() || changes.len() > 256 {
            return Err(Error::Invalid);
        }
        let mut next = serde_json::to_value(config).map_err(|_| Error::Invalid)?;
        let mut previous: Vec<&str> = Vec::new();
        for (path, value) in &changes {
            if !path.starts_with('/')
                || path.len() > 512
                || previous.iter().any(|p| path.starts_with(&format!("{p}/")))
            {
                return Err(Error::Invalid);
            }
            *next.pointer_mut(path).ok_or(Error::Invalid)? = value.clone();
            previous.push(path);
        }
        let next: Config = serde_json::from_value(next).map_err(|_| Error::Invalid)?;
        let mut effective = next.clone();
        self.overrides.clone().apply(&mut effective);
        effective.validate().map_err(|_| Error::Invalid)?;
        crate::tls::load(&effective).map_err(|_| Error::Invalid)?;
        let output = serde_json::to_vec_pretty(&next).map_err(|_| Error::Invalid)?;
        if output.len() as u64 > LIMIT {
            return Err(Error::Invalid);
        }
        if revision(&self.read()?.0) != expected {
            return Err(Error::Conflict);
        }
        self.replace(&output)?;
        self.project(&output, &next)
    }

    fn replace(&self, data: &[u8]) -> Result<(), Error> {
        let parent = self.path.parent().ok_or(Error::Unavailable)?;
        let temp = parent.join(format!(
            ".stream-kit-config-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| Error::Unavailable)?;
        let result = (|| {
            file.write_all(data)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &self.path)?;
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            Ok::<_, std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.map_err(|_| Error::Unavailable)
    }
}

fn redact(values: &mut Value, path: &str, paths: &mut Vec<String>) {
    if let Some(value) = values.pointer_mut(path)
        && !value.is_null()
        && value != ""
    {
        *value = Value::Null;
        paths.push(path.into());
    }
}

fn differences(file: &Value, effective: &Value, path: &str, paths: &mut Vec<String>) {
    if file == effective {
        return;
    }
    if let (Some(a), Some(b)) = (file.as_object(), effective.as_object()) {
        for (key, value) in a {
            differences(
                value,
                b.get(key).unwrap_or(&Value::Null),
                &format!("{path}/{key}"),
                paths,
            );
        }
    } else {
        paths.push(path.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Result<(PathBuf, Settings), Box<dyn std::error::Error>> {
        let dir = std::env::temp_dir().join(format!(
            "stream-kit-native-settings-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir)?;
        let path = dir.join("config.json");
        let mut config = Config::default();
        config.web_server.media_ticket_secret =
            Some("original-private-secret-1234567890123456".into());
        config.web_server.control_plane_url = Some("http://127.0.0.1:9000".into());
        let source = serde_json::to_string(&config)?;
        fs::write(&path, &source)?;
        Ok((
            dir,
            Settings::new(path, Some(&source), CliConfig::default()),
        ))
    }

    #[test]
    fn saves_preserve_hidden_fields_and_reject_stale_or_invalid_edits()
    -> Result<(), Box<dyn std::error::Error>> {
        let (dir, settings) = fixture()?;
        let before = settings.view()?;
        assert!(!before.restart_required);
        assert_eq!(before.running_revision.as_ref(), Some(&before.revision));
        assert!(!serde_json::to_string(&before)?.contains("original-private-secret"));
        let changes = BTreeMap::from([(
            "/moonlight/pair_device_name".into(),
            Value::String("Unified gateway".into()),
        )]);
        let saved = settings.save(&before.revision, changes.clone())?;
        assert!(saved.restart_required);
        assert_eq!(saved.running_revision, before.running_revision);
        let source = fs::read_to_string(&settings.path)?;
        let restarted = Settings::new(settings.path.clone(), Some(&source), CliConfig::default());
        let applied = restarted.view()?;
        assert!(!applied.restart_required);
        assert_eq!(applied.running_revision.as_ref(), Some(&saved.revision));
        assert!(matches!(
            settings.save(&before.revision, changes),
            Err(Error::Conflict)
        ));
        let bytes = fs::read(&settings.path)?;
        assert!(String::from_utf8(bytes.clone())?.contains("original-private-secret"));
        let invalid = BTreeMap::from([(
            "/webrtc/port_range".into(),
            serde_json::json!({"min":90,"max":80}),
        )]);
        assert!(matches!(
            settings.save(&saved.revision, invalid),
            Err(Error::Invalid)
        ));
        assert_eq!(fs::read(&settings.path)?, bytes);
        let overlapping = BTreeMap::from([
            ("/moonlight".into(), serde_json::json!({})),
            ("/moonlight/pair_device_name".into(), Value::Null),
        ]);
        assert!(matches!(
            settings.save(&saved.revision, overlapping),
            Err(Error::Invalid)
        ));
        fs::remove_file(&settings.path)?;
        fs::remove_dir(dir)?;
        Ok(())
    }

    #[test]
    fn tls_save_checks_files_and_key_match_before_replacement()
    -> Result<(), Box<dyn std::error::Error>> {
        let (dir, settings) = fixture()?;
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tls");
        let before = settings.view()?;
        let bytes = fs::read(&settings.path)?;
        for key in ["missing.pem", "other-test-key.pem.fixture"] {
            let changes = BTreeMap::from([(
                "/web_server/certificate".into(),
                serde_json::json!({
                    "certificate_pem": fixtures.join("test-cert.pem.fixture"),
                    "private_key_pem": fixtures.join(key),
                }),
            )]);
            assert!(matches!(
                settings.save(&before.revision, changes),
                Err(Error::Invalid)
            ));
            assert_eq!(fs::read(&settings.path)?, bytes);
        }
        let saved = settings.save(
            &before.revision,
            BTreeMap::from([(
                "/web_server/certificate".into(),
                serde_json::json!({
                    "certificate_pem": fixtures.join("test-cert.pem.fixture"),
                    "private_key_pem": fixtures.join("test-key.pem.fixture"),
                }),
            )]),
        )?;
        assert!(saved.restart_required);
        assert!(
            saved
                .values
                .pointer("/web_server/certificate")
                .is_some_and(Value::is_null)
        );
        fs::remove_file(&settings.path)?;
        fs::remove_dir(dir)?;
        Ok(())
    }

    #[test]
    fn deployment_overrides_remain_private_and_external_edits_conflict()
    -> Result<(), Box<dyn std::error::Error>> {
        let (dir, mut settings) = fixture()?;
        settings.overrides.media_ticket_secret =
            Some("external-private-secret-1234567890123456".into());
        let before = settings.view()?;
        assert!(
            before
                .overridden_paths
                .contains(&"/web_server/media_ticket_secret".into())
        );
        assert!(!serde_json::to_string(&before)?.contains("external-private-secret"));
        let changes = BTreeMap::from([(
            "/moonlight/pair_device_name".into(),
            Value::String("new".into()),
        )]);
        settings.save(&before.revision, changes.clone())?;
        assert!(!fs::read_to_string(&settings.path)?.contains("external-private-secret"));
        let before = settings.view()?;
        let mut bytes = fs::read(&settings.path)?;
        bytes.push(b' ');
        fs::write(&settings.path, &bytes)?;
        assert!(matches!(
            settings.save(&before.revision, changes),
            Err(Error::Conflict)
        ));
        assert_eq!(fs::read(&settings.path)?, bytes);
        fs::remove_file(&settings.path)?;
        fs::remove_dir(dir)?;
        Ok(())
    }
}
