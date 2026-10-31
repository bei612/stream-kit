//! Offline first installation uses the runtime's storage schema and password
//! implementation. No HTTP listener or asynchronous persistence is involved.
use super::versions::{Json, V2UserPassword, V3, V3Role, V3RolePermissions, V3RoleType, V3User};
use crate::{
    app::password::StoragePassword,
    config::{Config, StorageConfig},
};
use anyhow::{Context, bail};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    name: String,
    password: String,
}

fn initial_data(mut input: impl Read) -> anyhow::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input.by_ref().take(16385).read_to_end(&mut bytes)?;
    if bytes.len() > 16384 {
        bail!("credential input exceeds size limit");
    }
    // Never include serde's error value: it can contain submitted credentials.
    let credentials: Credentials = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("expected JSON containing name and password"))?;
    if credentials.name.trim().is_empty()
        || credentials.name.len() > 128
        || credentials.name.chars().any(char::is_control)
    {
        bail!("administrator name must contain 1-128 bytes without control characters");
    }
    if credentials.password.len() < 12 || credentials.password.len() > 1024 {
        bail!("administrator password must contain 12-1024 bytes");
    }
    let password = StoragePassword::new(&credentials.password)?;
    let data = Json::V3(V3 {
        users: HashMap::from([(
            0,
            V3User {
                name: credentials.name.clone(),
                client_unique_id: credentials.name,
                role_id: 0,
                password: Some(V2UserPassword {
                    salt: password.salt,
                    hash: password.hash,
                    iterations: password.iterations,
                }),
            },
        )]),
        roles: HashMap::from([(
            0,
            V3Role {
                name: "Admin".into(),
                ty: V3RoleType::Admin,
                default_settings: Default::default(),
                permissions: V3RolePermissions::default(),
            },
        )]),
        hosts: HashMap::new(),
        default_role_id: None,
        default_user_id: None,
    });
    Ok(serde_json::to_vec_pretty(&data)?)
}

pub fn initialize_admin(config: &Config, input: impl Read) -> anyhow::Result<()> {
    config.validate().map_err(anyhow::Error::msg)?;
    if config.web_server.first_login_create_admin {
        bail!("disable first_login_create_admin before offline initialization");
    }
    let StorageConfig::Json { path, .. } = &config.data_storage;
    let bytes = initial_data(input)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // The installer creates the protected parent directory. Existing data,
    // including an empty or malformed file, must never be adopted or replaced.
    let mut file = options.open(path).context(
        "cannot create new gateway storage; check directory permissions and existing data",
    )?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_persists_before_return_and_never_replaces_existing_data() {
        let path = std::env::temp_dir().join(format!(
            "stream-kit-bootstrap-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("test clock must be after Unix epoch")
                .as_nanos()
        ));
        let mut config = Config::default();
        config.web_server.first_login_create_admin = false;
        let StorageConfig::Json {
            path: configured, ..
        } = &mut config.data_storage;
        *configured = path.to_string_lossy().into_owned();
        let input = br#"{"name":"admin","password":"test-only-password"}"#.as_slice();
        initialize_admin(&config, input).expect("initialize fresh test storage");
        let original = std::fs::read(&path).expect("read persisted administrator storage");
        assert!(matches!(
            serde_json::from_slice::<Json>(&original).expect("decode persisted storage"),
            Json::V3(_)
        ));
        assert!(initialize_admin(&config, input).is_err());
        assert_eq!(
            original,
            std::fs::read(&path).expect("read unchanged storage")
        );
        std::fs::remove_file(&path).expect("remove test storage");
        config.web_server.first_login_create_admin = true;
        assert!(initialize_admin(&config, input).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn offline_admin_uses_runtime_password_format_without_anonymous_defaults() {
        let raw = initial_data(br#"{"name":"admin","password":"test-only-password"}"#.as_slice())
            .expect("encode test administrator in runtime storage format");
        assert!(!String::from_utf8_lossy(&raw).contains("test-only-password"));
        let Json::V3(data) = serde_json::from_slice(&raw).expect("decode initial runtime storage")
        else {
            panic!("wrong storage version")
        };
        assert_eq!(data.users.len(), 1);
        assert_eq!(data.roles.len(), 1);
        assert!(
            data.hosts.is_empty()
                && data.default_user_id.is_none()
                && data.default_role_id.is_none()
        );
        assert!(matches!(data.roles[&0].ty, V3RoleType::Admin));
        let password = data.users[&0]
            .password
            .as_ref()
            .expect("administrator has a password hash");
        let password = StoragePassword {
            salt: password.salt,
            hash: password.hash,
            iterations: password.iterations,
        };
        assert!(
            password
                .verify("test-only-password")
                .expect("verify test credential")
        );
        assert!(
            !password
                .verify("wrong-password")
                .expect("verify wrong credential")
        );
    }

    #[test]
    fn malformed_and_oversized_credentials_are_rejected_without_echo() {
        for input in [
            br#"{"password":"sensitive-secret","name":123}"#.as_slice(),
            br#"{"name":"admin","password":"short"}"#.as_slice(),
            &[b'x'; 16385],
        ] {
            let message = initial_data(input)
                .expect_err("reject malformed credential input")
                .to_string();
            assert!(!message.contains("sensitive-secret"));
        }
    }
}
