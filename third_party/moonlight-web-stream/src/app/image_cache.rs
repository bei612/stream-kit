use std::collections::VecDeque;

use bytes::Bytes;

use super::{
    host::{AppId, HostId},
    user::UserId,
};

type Key = (UserId, HostId, AppId);
const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Small FIFO cover cache. Count and byte budgets apply across all hosts;
/// application churn cannot retain every previously viewed image forever.
#[derive(Default)]
pub(super) struct ImageCache {
    entries: VecDeque<(Key, Bytes)>,
    bytes: usize,
}

impl ImageCache {
    pub fn get(&self, key: &Key) -> Option<&Bytes> {
        self.entries
            .iter()
            .find(|(entry, _)| entry == key)
            .map(|(_, image)| image)
    }

    pub fn insert(&mut self, key: Key, image: Bytes) {
        if let Some(index) = self.entries.iter().position(|(entry, _)| *entry == key)
            && let Some((_, previous)) = self.entries.remove(index)
        {
            self.bytes -= previous.len();
        }
        if image.len() > MAX_BYTES {
            return;
        }
        while self.entries.len() >= MAX_ENTRIES || image.len() > MAX_BYTES - self.bytes {
            if let Some((_, previous)) = self.entries.pop_front() {
                self.bytes -= previous.len();
            }
        }
        self.bytes += image.len();
        self.entries.push_back((key, image));
    }

    pub fn remove_host(&mut self, host: HostId) {
        self.entries
            .retain(|((_, entry_host, _), _)| *entry_host != host);
        self.bytes = self.entries.iter().map(|(_, image)| image.len()).sum();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn churn_replacement_and_host_removal_keep_both_budgets() {
        let mut cache = ImageCache::default();
        for app in 0..10000 {
            cache.insert(
                (UserId(1), HostId(1), AppId(app)),
                Bytes::from(vec![0; 1024]),
            );
        }
        assert_eq!(cache.entries.len(), MAX_ENTRIES);
        assert_eq!(cache.bytes, MAX_ENTRIES * 1024);
        assert!(cache.get(&(UserId(1), HostId(1), AppId(0))).is_none());
        for app in 0..100 {
            cache.insert(
                (UserId(1), HostId(2), AppId(app)),
                Bytes::from(vec![0; 1024 * 1024]),
            );
            assert!(cache.bytes <= MAX_BYTES);
        }
        assert_eq!(cache.entries.len(), 32);
        let key = (UserId(1), HostId(2), AppId(99));
        cache.insert(key, Bytes::from_static(b"replacement"));
        assert_eq!(cache.bytes, 31 * 1024 * 1024 + 11);
        assert_eq!(
            cache.get(&key).expect("replacement is cached").as_ref(),
            b"replacement"
        );
        cache.remove_host(HostId(2));
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
    }
}
