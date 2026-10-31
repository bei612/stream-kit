//! Audio authority boot identity, generated locally once per process.
//! Unlike the supervisor's process correlation ID, this cannot be inherited
//! from an environment variable or reused by a restarting service wrapper.
use std::sync::OnceLock;

static INSTANCE: OnceLock<String> = OnceLock::new();

pub fn instance_id() -> &'static str {
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_shared_across_threads_and_is_a_random_uuid() {
        let first = instance_id();
        assert_eq!(first.len(), 32);
        let id = uuid::Uuid::parse_str(first).expect("valid boot identity");
        assert_eq!(id.get_version_num(), 4);
        let other = std::thread::spawn(instance_id)
            .join()
            .expect("identity thread");
        assert_eq!(first, other);
        assert_eq!(first, instance_id());
    }
}
