//! Session-owned input reconciliation. Browsers submit intent; only this
//! runtime owns pressed state and emits host input or ownership cleanup.
use super::media::ControlGrant;
use moonlight_common::stream::{
    control::{
        ActiveGamepads, CompactKeyStates, KeyAction, KeyCode, KeyFlags, KeyModifiers, MouseButton,
        MouseButtonAction, TouchEventType,
    },
    proto::control::packet::ControlPacket,
};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Held {
    Key(i16),
    Mouse(i32),
    Touch(u32),
    Pen,
    Pad(u8),
    PadTouch(u8, u8, u32),
}

#[derive(Default)]
pub struct InputRuntime {
    owner: Option<ControlGrant>,
    releases: BTreeMap<Held, ControlPacket>,
    keys: CompactKeyStates,
    sequence: Option<u16>,
}

impl InputRuntime {
    /// Must run before every accepted input and periodically for idle owners.
    pub fn reconcile(&mut self, owner: Option<ControlGrant>) -> Vec<ControlPacket> {
        if self.owner == owner {
            return vec![];
        }
        self.owner = owner;
        self.keys = CompactKeyStates::default();
        self.sequence = None;
        std::mem::take(&mut self.releases).into_values().collect()
    }

    pub fn accept(&mut self, packet: ControlPacket) -> Vec<ControlPacket> {
        if self.owner.is_none() {
            return vec![];
        }
        if let ControlPacket::WebState {
            sequence_number,
            keys,
        } = packet
        {
            if self.sequence.is_some_and(|last| {
                let distance = sequence_number.wrapping_sub(last);
                distance == 0 || distance >= 0x8000
            }) {
                return vec![];
            }
            self.sequence = Some(sequence_number);
            let modifiers = extract_modifiers(keys);
            let mut output = vec![];
            for key in (self.keys & !keys).pressed_iter() {
                let mut packet = self
                    .releases
                    .get(&Held::Key(key.0))
                    .cloned()
                    .unwrap_or_else(|| key_packet(key, KeyAction::Up, modifiers));
                if let ControlPacket::Keyboard {
                    modifiers: released,
                    ..
                } = &mut packet
                {
                    *released = modifiers | (*released & KeyModifiers::EXTENDED);
                }
                output.extend(self.accept(packet));
            }
            for key in (keys & !self.keys).pressed_iter() {
                output.extend(self.accept(key_packet(key, KeyAction::Down, modifiers)));
            }
            self.keys = keys;
            return output;
        }
        let mut release = packet.clone();
        let held = match &mut release {
            ControlPacket::Keyboard {
                action,
                flags: _,
                key_code,
                modifiers,
                ..
            } => {
                if !(1..256).contains(&key_code.0) {
                    return vec![];
                }
                let held = Held::Key(key_code.0);
                self.keys.set_pressed(*key_code, *action);
                if *action == KeyAction::Up {
                    self.releases.remove(&held);
                    return vec![packet];
                }
                *action = KeyAction::Up;
                *modifiers &= KeyModifiers::EXTENDED;
                held
            }
            ControlPacket::MouseButton { action, button } => {
                let code = match button {
                    MouseButton::Left => KeyCode::VK_LBUTTON,
                    MouseButton::Middle => KeyCode::VK_MBUTTON,
                    MouseButton::Right => KeyCode::VK_RBUTTON,
                    MouseButton::X1 => KeyCode::VK_XBUTTON1,
                    MouseButton::X2 => KeyCode::VK_XBUTTON2,
                };
                self.keys.set_pressed(
                    code,
                    if *action == MouseButtonAction::Press {
                        KeyAction::Down
                    } else {
                        KeyAction::Up
                    },
                );
                let held = Held::Mouse(*button as i32);
                if *action == MouseButtonAction::Release {
                    self.releases.remove(&held);
                    return vec![packet];
                }
                *action = MouseButtonAction::Release;
                held
            }
            ControlPacket::Touch {
                event_type,
                pointer_id,
                pressure_or_distance,
                ..
            } => {
                let held = Held::Touch(*pointer_id);
                if !self.contact(held, *event_type) {
                    return vec![packet];
                }
                *event_type = TouchEventType::Cancel;
                *pressure_or_distance = 0.0;
                held
            }
            ControlPacket::Pen {
                event_type,
                buttons,
                pressure_or_distance,
                ..
            } => {
                if !self.contact(Held::Pen, *event_type) {
                    return vec![packet];
                }
                *event_type = TouchEventType::Cancel;
                *buttons = moonlight_common::stream::control::PenButtons::empty();
                *pressure_or_distance = 0.0;
                Held::Pen
            }
            ControlPacket::ControllerState {
                controller_number, ..
            } => {
                if !(0..16).contains(controller_number) {
                    return vec![];
                }
                let number = *controller_number as u8;
                release = neutral_pad(number);
                Held::Pad(number)
            }
            ControlPacket::ControllerArrival {
                controller_number, ..
            } => {
                if *controller_number >= 16 {
                    return vec![];
                }
                let number = *controller_number;
                release = neutral_pad(number);
                Held::Pad(number)
            }
            ControlPacket::ControllerTouch {
                controller_number,
                touchpad_index,
                pointer_id,
                event_type,
                pressure,
                ..
            } => {
                if *controller_number >= 16 {
                    return vec![];
                }
                let held = Held::PadTouch(*controller_number, *touchpad_index, *pointer_id);
                if !self.contact(held, *event_type) {
                    return vec![packet];
                }
                *event_type = TouchEventType::Cancel;
                *pressure = 0.0;
                held
            }
            ControlPacket::ControllerMotion {
                controller_number, ..
            }
            | ControlPacket::ControllerBattery {
                controller_number, ..
            } => {
                return if *controller_number < 16 {
                    vec![packet]
                } else {
                    vec![]
                };
            }
            ControlPacket::MouseMoveRelative { .. }
            | ControlPacket::MouseMoveAbsolute { .. }
            | ControlPacket::MouseScroll { .. }
            | ControlPacket::MouseHorizontalScroll { .. }
            | ControlPacket::Text { .. } => return vec![packet],
            // Stream lifecycle and server-to-client messages are never input.
            _ => return vec![],
        };
        // Keyboard/buttons/gamepads have finite protocol identifiers. Contact
        // IDs are arbitrary u32 values, so bound outstanding contacts to 64.
        if matches!(held, Held::Touch(_) | Held::Pen | Held::PadTouch(..))
            && !self.releases.contains_key(&held)
            && self
                .releases
                .keys()
                .filter(|k| matches!(k, Held::Touch(_) | Held::Pen | Held::PadTouch(..)))
                .count()
                >= 64
        {
            return vec![];
        }
        self.releases.insert(held, release);
        vec![packet]
    }

    fn contact(&mut self, held: Held, event: TouchEventType) -> bool {
        if event == TouchEventType::CancelAll {
            self.releases.retain(|key, _| match (held, *key) {
                (Held::Touch(_), Held::Touch(_)) | (Held::Pen, Held::Pen) => false,
                (Held::PadTouch(a, b, _), Held::PadTouch(c, d, _)) => a != c || b != d,
                _ => true,
            });
            return false;
        }
        if matches!(
            event,
            TouchEventType::Up | TouchEventType::Cancel | TouchEventType::HoverLeave
        ) {
            self.releases.remove(&held);
            return false;
        }
        true
    }
}

fn neutral_pad(number: u8) -> ControlPacket {
    ControlPacket::controller_state(
        ActiveGamepads::empty(),
        number as i16,
        moonlight_common::stream::control::ControllerButtons::empty(),
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    )
}

fn key_packet(key_code: KeyCode, action: KeyAction, modifiers: KeyModifiers) -> ControlPacket {
    let button = match key_code {
        KeyCode::VK_LBUTTON => Some(MouseButton::Left),
        KeyCode::VK_MBUTTON => Some(MouseButton::Middle),
        KeyCode::VK_RBUTTON => Some(MouseButton::Right),
        KeyCode::VK_XBUTTON1 => Some(MouseButton::X1),
        KeyCode::VK_XBUTTON2 => Some(MouseButton::X2),
        _ => None,
    };
    if let Some(button) = button {
        ControlPacket::MouseButton {
            action: if action == KeyAction::Down {
                MouseButtonAction::Press
            } else {
                MouseButtonAction::Release
            },
            button,
        }
    } else {
        ControlPacket::Keyboard {
            action,
            flags: KeyFlags::empty(),
            key_code,
            modifiers,
            zero: 0,
        }
    }
}

fn extract_modifiers(keys: CompactKeyStates) -> KeyModifiers {
    let mut modifiers = KeyModifiers::empty();
    for (flag, codes) in [
        (
            KeyModifiers::SHIFT,
            &[KeyCode::VK_SHIFT, KeyCode::VK_LSHIFT, KeyCode::VK_RSHIFT][..],
        ),
        (
            KeyModifiers::CTRL,
            &[
                KeyCode::VK_CONTROL,
                KeyCode::VK_LCONTROL,
                KeyCode::VK_RCONTROL,
            ][..],
        ),
        (
            KeyModifiers::ALT,
            &[KeyCode::VK_MENU, KeyCode::VK_LMENU, KeyCode::VK_RMENU][..],
        ),
        (
            KeyModifiers::META,
            &[KeyCode::VK_LWIN, KeyCode::VK_RWIN][..],
        ),
    ] {
        if codes
            .iter()
            .any(|key| keys.is_pressed(*key) == Some(KeyAction::Down))
        {
            modifiers |= flag;
        }
    }
    modifiers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{
        host::{AppId, HostId},
        media::{MediaSessionKey, MediaSessionRegistry},
    };

    async fn owner() -> ControlGrant {
        let registry = MediaSessionRegistry::new();
        let key = MediaSessionKey {
            host_id: HostId(1),
            app_id: AppId(2),
        };
        registry
            .attach(key.clone(), "a".into())
            .await
            .expect("attach");
        registry
            .claim_controller(&key, "a", false)
            .await
            .expect("claim");
        registry
            .with_controller(&key, "a", |grant| grant)
            .await
            .expect("owner")
    }

    fn touch(id: u32, event_type: TouchEventType) -> ControlPacket {
        ControlPacket::Touch {
            event_type,
            reserved: 0,
            rotation: 0,
            pointer_id: id,
            x: 0.5,
            y: 0.5,
            pressure_or_distance: 0.5,
            contact_area_minor: 0.0,
            contact_area_major: 0.0,
        }
    }

    #[tokio::test]
    async fn releases_all_inputs_and_reinitializes_identical_keyboard_snapshot() {
        let owner = owner().await;
        let mut input = InputRuntime::default();
        input.reconcile(Some(owner.clone()));
        let mut keys = CompactKeyStates::default();
        keys.set_pressed(KeyCode(0x41), KeyAction::Down);
        keys.set_pressed(KeyCode::VK_LBUTTON, KeyAction::Down);
        assert_eq!(
            input
                .accept(ControlPacket::WebState {
                    sequence_number: 42,
                    keys
                })
                .len(),
            2
        );
        assert_eq!(input.accept(touch(7, TouchEventType::Down)).len(), 1);
        assert_eq!(input.accept(neutral_pad(0)).len(), 1);
        assert!(
            input.reconcile(Some(owner.clone())).is_empty(),
            "heartbeat must not release keys"
        );
        let releases = input.reconcile(None);
        assert_eq!(releases.len(), 4);
        assert!(releases.iter().any(|p| matches!(
            p,
            ControlPacket::Keyboard {
                action: KeyAction::Up,
                key_code: KeyCode(0x41),
                ..
            }
        )));
        assert!(releases.iter().any(|p| matches!(
            p,
            ControlPacket::MouseButton {
                action: MouseButtonAction::Release,
                ..
            }
        )));
        assert!(releases.iter().any(|p| matches!(
            p,
            ControlPacket::Touch {
                event_type: TouchEventType::Cancel,
                pointer_id: 7,
                ..
            }
        )));
        assert!(input.reconcile(None).is_empty());
        assert!(input.accept(touch(8, TouchEventType::Down)).is_empty());
        input.reconcile(Some(owner));
        assert_eq!(
            input
                .accept(ControlPacket::WebState {
                    sequence_number: 42,
                    keys
                })
                .len(),
            2,
            "new ownership must emit fresh downs even for an identical snapshot"
        );
    }

    #[tokio::test]
    async fn keyboard_sequence_handles_wrap_duplicate_and_reordering() {
        let mut input = InputRuntime::default();
        input.reconcile(Some(owner().await));
        let mut down = CompactKeyStates::default();
        down.set_pressed(KeyCode(0x41), KeyAction::Down);
        assert_eq!(
            input
                .accept(ControlPacket::WebState {
                    sequence_number: u16::MAX,
                    keys: down
                })
                .len(),
            1
        );
        assert!(
            input
                .accept(ControlPacket::WebState {
                    sequence_number: u16::MAX - 1,
                    keys: Default::default()
                })
                .is_empty()
        );
        assert!(
            input
                .accept(ControlPacket::WebState {
                    sequence_number: u16::MAX,
                    keys: Default::default()
                })
                .is_empty()
        );
        assert_eq!(
            input
                .accept(ControlPacket::WebState {
                    sequence_number: 0,
                    keys: Default::default()
                })
                .len(),
            1
        );
        assert!(input.reconcile(None).is_empty());
    }

    #[tokio::test]
    async fn keyboard_snapshot_reconciles_direct_packets_without_losing_key_flags() {
        let mut input = InputRuntime::default();
        input.reconcile(Some(owner().await));
        input.accept(ControlPacket::Keyboard {
            action: KeyAction::Down,
            flags: KeyFlags::SUNSHINE_NON_NORMALIZED,
            key_code: KeyCode::VK_RCONTROL,
            modifiers: KeyModifiers::CTRL | KeyModifiers::EXTENDED,
            zero: 0,
        });
        input.accept(ControlPacket::MouseButton {
            action: MouseButtonAction::Press,
            button: MouseButton::X1,
        });
        let output = input.accept(ControlPacket::WebState {
            sequence_number: 1,
            keys: Default::default(),
        });
        assert_eq!(output.len(), 2);
        assert!(output.iter().any(
            |p| matches!(p, ControlPacket::Keyboard { action: KeyAction::Up, flags, modifiers, .. }
            if *flags == KeyFlags::SUNSHINE_NON_NORMALIZED && *modifiers == KeyModifiers::EXTENDED)
        ));
        assert!(input.reconcile(None).is_empty());
    }

    #[tokio::test]
    async fn contacts_are_bounded_cancelled_and_transport_packets_are_rejected() {
        let mut input = InputRuntime::default();
        input.reconcile(Some(owner().await));
        for id in 0..64 {
            assert_eq!(input.accept(touch(id, TouchEventType::Down)).len(), 1);
        }
        assert!(input.accept(touch(64, TouchEventType::Down)).is_empty());
        assert_eq!(input.accept(touch(0, TouchEventType::Up)).len(), 1);
        assert_eq!(input.accept(touch(64, TouchEventType::Down)).len(), 1);
        input.accept(touch(0, TouchEventType::CancelAll));
        assert!(input.reconcile(None).is_empty());
        input.reconcile(Some(owner().await));
        for packet in [
            ControlPacket::StartB,
            ControlPacket::PeriodicPing,
            ControlPacket::RequestIdr,
        ] {
            assert!(input.accept(packet).is_empty());
        }
    }

    #[tokio::test]
    async fn extended_keyboard_and_pen_release_preserve_device_semantics() {
        use moonlight_common::stream::control::{PenButtons, ToolType};
        let mut input = InputRuntime::default();
        input.reconcile(Some(owner().await));
        input.accept(ControlPacket::Keyboard {
            action: KeyAction::Down,
            flags: KeyFlags::SUNSHINE_NON_NORMALIZED,
            key_code: KeyCode::VK_RCONTROL,
            modifiers: KeyModifiers::CTRL | KeyModifiers::EXTENDED,
            zero: 0,
        });
        input.accept(ControlPacket::Pen {
            event_type: TouchEventType::Down,
            tool_type: ToolType::Pen,
            buttons: PenButtons::PRIMARY,
            zero: 0,
            x: 0.2,
            y: 0.3,
            pressure_or_distance: 0.8,
            rotation: 0,
            tilt: 0,
            zero2: 0,
            contact_area_minor: 0.0,
            contact_area_major: 0.0,
        });
        input.accept(ControlPacket::ControllerTouch {
            controller_number: 0,
            event_type: TouchEventType::Down,
            zero: 0,
            touchpad_index: 0,
            pointer_id: 1,
            x: 0.5,
            y: 0.5,
            pressure: 1.0,
        });
        let releases = input.reconcile(None);
        assert_eq!(releases.len(), 3);
        assert!(releases.iter().any(
            |p| matches!(p, ControlPacket::Keyboard { action: KeyAction::Up, flags, modifiers, .. }
            if *flags == KeyFlags::SUNSHINE_NON_NORMALIZED && *modifiers == KeyModifiers::EXTENDED)
        ));
        assert!(releases.iter().any(|p| matches!(p, ControlPacket::Pen { event_type: TouchEventType::Cancel, buttons, pressure_or_distance, .. }
            if buttons.is_empty() && *pressure_or_distance == 0.0)));
        assert!(releases.iter().any(|p| matches!(p, ControlPacket::ControllerTouch { event_type: TouchEventType::Cancel, pressure, .. } if *pressure == 0.0)));
    }
}
