/// placement.rs — where the on-screen orb sits.
///
/// The orb lives in one of 8 spots on the screen's work area (4 corners, top/bottom
/// centre, left/right edge middles), plus a horizontal shift the user sets in Settings.
/// Dragging the orb and letting go snaps it to the nearest spot.
///
/// The window grows away from the screen edge when it needs more room (right-click
/// menu, error message), so the orb itself never moves: a right-column spot grows
/// leftwards, a top-row spot grows downwards, and so on. `MicBubble.tsx` mirrors this
/// when it lays out the orb inside a bigger window.
///
/// All maths here is in physical pixels; callers pass the work area and sizes.

pub const SPOTS: [&str; 8] = ["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"];
pub const DEFAULT_SPOT: &str = "br";
/// Logical size of the square the orb is drawn in (matches ORB_BOX in OrbBubble.tsx).
pub const ORB_BOX: f64 = 64.0;
/// Gap between the orb box and the screen edge, logical points (before scaling).
pub const EDGE_MARGIN: f64 = 6.0;
/// Limit for the left/right shift slider, logical points.
pub const NUDGE_MAX: f64 = 600.0;

#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub fn is_spot(s: &str) -> bool {
    SPOTS.contains(&s)
}

/// (row, col): row is t/m/b, col is l/c/r.
fn parts(spot: &str) -> (char, char) {
    let mut c = spot.chars();
    let row = c.next().unwrap_or('b');
    let col = c.next().unwrap_or('r');
    (row, col)
}

/// Top-left of the orb box for a spot, shifted by (`nudge`, `nudge_y`) and clamped so
/// the orb stays on screen.
pub fn orb_origin(spot: &str, area: Area, orb: f64, margin: f64, nudge: f64, nudge_y: f64) -> (f64, f64) {
    let (row, col) = parts(spot);
    let min_x = area.x + margin;
    let max_x = (area.x + area.w - orb - margin).max(min_x);
    let x = match col {
        'l' => min_x,
        'r' => max_x,
        _ => area.x + (area.w - orb) / 2.0,
    };
    let min_y = area.y + margin;
    let max_y = (area.y + area.h - orb - margin).max(min_y);
    let y = match row {
        't' => min_y,
        'm' => area.y + (area.h - orb) / 2.0,
        _ => max_y,
    };
    ((x + nudge).clamp(min_x, max_x), (y + nudge_y).clamp(min_y, max_y))
}

/// Top-left of a `w`×`h` window that keeps the orb box at `orb_at`, growing away from
/// the screen edge.
pub fn window_origin(spot: &str, orb_at: (f64, f64), orb: f64, w: f64, h: f64) -> (f64, f64) {
    let (row, col) = parts(spot);
    let x = match col {
        'l' => orb_at.0,
        'r' => orb_at.0 + orb - w,
        _ => orb_at.0 + orb / 2.0 - w / 2.0,
    };
    let y = match row {
        't' => orb_at.1,
        _ => orb_at.1 + orb - h,
    };
    (x, y)
}

/// The spot whose orb centre is closest to (cx, cy).
pub fn nearest_spot(area: Area, orb: f64, margin: f64, cx: f64, cy: f64) -> &'static str {
    SPOTS
        .iter()
        .min_by(|a, b| {
            let d = |s: &str| {
                let (x, y) = orb_origin(s, area, orb, margin, 0.0, 0.0);
                let (dx, dy) = (x + orb / 2.0 - cx, y + orb / 2.0 - cy);
                dx * dx + dy * dy
            };
            d(a).total_cmp(&d(b))
        })
        .copied()
        .unwrap_or(DEFAULT_SPOT)
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: Area = Area { x: 0.0, y: 25.0, w: 1600.0, h: 975.0 };

    #[test]
    fn corners_and_centres() {
        assert_eq!(orb_origin("tl", A, 60.0, 6.0, 0.0, 0.0), (6.0, 31.0));
        assert_eq!(orb_origin("br", A, 60.0, 6.0, 0.0, 0.0), (1534.0, 934.0));
        assert_eq!(orb_origin("tc", A, 60.0, 6.0, 0.0, 0.0), (770.0, 31.0));
        assert_eq!(orb_origin("ml", A, 60.0, 6.0, 0.0, 0.0).1, 25.0 + (975.0 - 60.0) / 2.0);
    }

    #[test]
    fn nudge_is_clamped_on_screen() {
        assert_eq!(orb_origin("br", A, 60.0, 6.0, 500.0, 0.0).0, 1534.0);
        assert_eq!(orb_origin("bc", A, 60.0, 6.0, -100.0, 0.0).0, 670.0);
        assert_eq!(orb_origin("bl", A, 60.0, 6.0, -50.0, 0.0).0, 6.0);
    }

    #[test]
    fn vertical_nudge_is_clamped() {
        assert_eq!(orb_origin("ml", A, 60.0, 6.0, 0.0, -100.0).1, 25.0 + (975.0 - 60.0) / 2.0 - 100.0);
        assert_eq!(orb_origin("br", A, 60.0, 6.0, 0.0, 200.0).1, 934.0);
        assert_eq!(orb_origin("tl", A, 60.0, 6.0, 0.0, -50.0).1, 31.0);
    }

    #[test]
    fn window_grows_away_from_edges() {
        // Bottom-right: a 200x264 menu window grows up and to the left.
        assert_eq!(window_origin("br", (1534.0, 934.0), 60.0, 200.0, 264.0), (1394.0, 730.0));
        // Top-left grows down and right.
        assert_eq!(window_origin("tl", (6.0, 31.0), 60.0, 200.0, 264.0), (6.0, 31.0));
        // Centre column grows evenly.
        assert_eq!(window_origin("tc", (770.0, 31.0), 60.0, 200.0, 264.0), (700.0, 31.0));
    }

    #[test]
    fn drop_snaps_to_nearest() {
        assert_eq!(nearest_spot(A, 60.0, 6.0, 1500.0, 900.0), "br");
        assert_eq!(nearest_spot(A, 60.0, 6.0, 30.0, 500.0), "ml");
        assert_eq!(nearest_spot(A, 60.0, 6.0, 820.0, 80.0), "tc");
        assert_eq!(nearest_spot(A, 60.0, 6.0, 300.0, 120.0), "tl");
    }
}
