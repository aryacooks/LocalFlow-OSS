pub const DOUBLE_TAP_MS: u64 = 300;

#[derive(Debug, PartialEq)]
pub enum Action {
    None,
    Start,
    Stop,
    Wait(u64),
}

#[derive(Default)]
pub struct FnGesture {
    down_at: Option<u64>,
    pending: Option<(u64, u64)>,
    latched: bool,
    generation: u64,
}

impl FnGesture {
    pub fn reset(&mut self) {
        self.down_at = None;
        self.pending = None;
        self.latched = false;
        self.generation += 1;
    }

    pub fn owns_recording(&self) -> bool {
        self.down_at.is_some() || self.pending.is_some() || self.latched
    }

    pub fn press(&mut self, now: u64, recording: bool, processing: bool) -> Action {
        if self.down_at.is_some() {
            return Action::None;
        }
        if !recording {
            self.reset();
        }
        if processing {
            self.reset();
            return Action::None;
        }
        if self.latched {
            self.reset();
            return Action::Stop;
        }
        if let Some((released, _)) = self.pending.take() {
            if now.saturating_sub(released) <= DOUBLE_TAP_MS {
                self.generation += 1;
                self.down_at = Some(now);
                self.latched = true;
                return Action::None;
            }
        }
        // Do not take over recordings started with another shortcut or the bubble.
        if recording {
            return Action::None;
        }
        self.down_at = Some(now);
        Action::Start
    }

    pub fn release(&mut self, now: u64) -> Action {
        let Some(pressed) = self.down_at.take() else {
            return Action::None;
        };
        if self.latched {
            return Action::None;
        }
        if now.saturating_sub(pressed) >= DOUBLE_TAP_MS {
            self.reset();
            return Action::Stop;
        }
        // Keep the same audio capture alive while waiting for a possible second tap.
        self.generation += 1;
        self.pending = Some((now, self.generation));
        Action::Wait(self.generation)
    }

    pub fn expire(&mut self, token: u64) -> Action {
        if self.pending.map(|(_, generation)| generation) != Some(token) {
            return Action::None;
        }
        self.reset();
        Action::Stop
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_records_until_release() {
        let mut g = FnGesture::default();
        assert_eq!(g.press(0, false, false), Action::Start);
        assert_eq!(g.press(100, true, false), Action::None);
        assert_eq!(g.release(500), Action::Stop);
    }

    #[test]
    fn double_tap_latches_until_next_press() {
        let mut g = FnGesture::default();
        assert_eq!(g.press(0, false, false), Action::Start);
        let Action::Wait(token) = g.release(60) else {
            panic!("expected wait")
        };
        assert_eq!(g.press(160, true, false), Action::None);
        assert_eq!(g.release(220), Action::None);
        assert_eq!(g.expire(token), Action::None);
        assert_eq!(g.press(1000, true, false), Action::Stop);
        assert_eq!(g.release(1100), Action::None);
    }

    #[test]
    fn single_tap_finishes_after_double_tap_window() {
        let mut g = FnGesture::default();
        g.press(0, false, false);
        let Action::Wait(token) = g.release(60) else {
            panic!("expected wait")
        };
        assert_eq!(g.expire(token), Action::Stop);
        assert_eq!(g.expire(token), Action::None);
    }

    #[test]
    fn disabling_or_cancelling_invalidates_pending_stop() {
        let mut g = FnGesture::default();
        g.press(0, false, false);
        let Action::Wait(token) = g.release(60) else {
            panic!("expected wait")
        };
        g.reset();
        assert_eq!(g.expire(token), Action::None);
        assert_eq!(g.press(200, false, true), Action::None);
        assert_eq!(g.release(600), Action::None);
    }

    #[test]
    fn leaves_other_recording_triggers_alone() {
        let mut g = FnGesture::default();
        assert_eq!(g.press(0, true, false), Action::None);
        assert_eq!(g.release(600), Action::None);
    }
}
