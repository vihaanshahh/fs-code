//! Grid layout computation — translates AgentGrid.tsx layout logic to ratatui Rects.
//!
//! Layouts:
//!   0 agents: welcome screen (full area)
//!   1 agent:  full area
//!   2 agents: vertical split (left | right)
//!   3 agents: top full-width | bottom two side-by-side
//!   4 agents: 2×2 grid
//!   5-9 agents: 3-column grid with ceil(n/3) rows

use ratatui::prelude::*;

/// Compute the grid layout rectangles for N agent panes within the given area.
pub fn compute_grid(area: Rect, n: usize) -> Vec<Rect> {
    match n {
        0 => vec![],
        1 => vec![area],
        2 => split_horizontal(area),
        3 => layout_3(area),
        4 => layout_4(area),
        _ => layout_grid(area, n),
    }
}

/// 2 agents: vertical split (left | right), 50/50
fn split_horizontal(area: Rect) -> Vec<Rect> {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);
    vec![chunks[0], chunks[1]]
}

/// 3 agents: top full-width, bottom two side-by-side
fn layout_3(area: Rect) -> Vec<Rect> {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    let bottom = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[1]);

    vec![rows[0], bottom[0], bottom[1]]
}

/// 4 agents: 2×2 grid
fn layout_4(area: Rect) -> Vec<Rect> {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    let top = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[0]);

    let bottom = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[1]);

    vec![top[0], top[1], bottom[0], bottom[1]]
}

/// 5-9 agents: 3-column grid with ceil(n/3) rows
fn layout_grid(area: Rect, n: usize) -> Vec<Rect> {
    let num_rows = (n + 2) / 3; // ceil(n/3)
    let row_constraints: Vec<Constraint> = (0..num_rows)
        .map(|_| Constraint::Ratio(1, num_rows as u32))
        .collect();

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(row_constraints)
        .split(area);

    let mut panes = Vec::with_capacity(n);
    let mut idx = 0;

    for row_rect in rows.iter() {
        let remaining = n - idx;
        let cols_in_row = remaining.min(3);

        let col_constraints: Vec<Constraint> = (0..cols_in_row)
            .map(|_| Constraint::Ratio(1, cols_in_row as u32))
            .collect();

        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints(col_constraints)
            .split(*row_rect);

        for col_rect in cols.iter() {
            panes.push(*col_rect);
            idx += 1;
            if idx >= n {
                break;
            }
        }
    }

    panes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(w: u16, h: u16) -> Rect {
        Rect::new(0, 0, w, h)
    }

    #[test]
    fn grid_0_agents_returns_empty() {
        assert!(compute_grid(area(80, 24), 0).is_empty());
    }

    #[test]
    fn grid_1_agent_returns_full_area() {
        let rects = compute_grid(area(80, 24), 1);
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0], area(80, 24));
    }

    #[test]
    fn grid_2_agents_splits_horizontal() {
        let rects = compute_grid(area(80, 24), 2);
        assert_eq!(rects.len(), 2);
        assert_eq!(rects[0].width + rects[1].width, 80);
        assert_eq!(rects[0].height, 24);
    }

    #[test]
    fn grid_4_agents_2x2() {
        let rects = compute_grid(area(80, 24), 4);
        assert_eq!(rects.len(), 4);
        // All panes should fit within the area
        for r in &rects {
            assert!(r.x + r.width <= 80);
            assert!(r.y + r.height <= 24);
        }
    }

    #[test]
    fn grid_9_agents_3x3() {
        let rects = compute_grid(area(90, 30), 9);
        assert_eq!(rects.len(), 9);
        // Should be 3 columns, 3 rows
        for r in &rects {
            assert!(r.x + r.width <= 90);
            assert!(r.y + r.height <= 30);
        }
    }

    #[test]
    fn grid_5_agents_has_5_panes() {
        let rects = compute_grid(area(90, 30), 5);
        assert_eq!(rects.len(), 5);
    }
}
