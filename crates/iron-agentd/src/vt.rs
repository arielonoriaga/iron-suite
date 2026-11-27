use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use iron_proto::{GridRow, GridSnapshot};

#[derive(Debug, Clone, Copy)]
struct VtSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for VtSize {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

/// Headless VT100/ANSI state machine powered by `alacritty_terminal::Term`.
/// Zero GPU resources are allocated; snapshots are computed lazily only when attached.
pub struct HeadlessVt {
    term: Term<VoidListener>,
    processor: Processor,
    cols: u16,
    rows: u16,
    seq: u64,
}

impl HeadlessVt {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.clamp(2, 512);
        let rows = rows.clamp(2, 256);
        let config = Config {
            scrolling_history: 2_000,
            ..Default::default()
        };
        let size = VtSize {
            cols: usize::from(cols),
            rows: usize::from(rows),
        };
        let term = Term::new(config, &size, VoidListener);
        Self {
            term,
            processor: Processor::new(),
            cols,
            rows,
            seq: 0,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> u64 {
        if !bytes.is_empty() {
            self.processor.advance(&mut self.term, bytes);
            self.seq = self.seq.saturating_add(1);
        }
        self.seq
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.clamp(2, 512);
        let rows = rows.clamp(2, 256);
        if cols == self.cols && rows == self.rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        let size = VtSize {
            cols: usize::from(cols),
            rows: usize::from(rows),
        };
        self.term.resize(size);
        self.seq = self.seq.saturating_add(1);
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn snapshot(&self, session_id: &str) -> GridSnapshot {
        let grid = self.term.grid();
        let screen_lines = grid.screen_lines();
        let cols = grid.columns();
        let mut lines = Vec::with_capacity(screen_lines);

        for row_idx in 0..screen_lines {
            let line = Line(row_idx as i32);
            let mut text = String::with_capacity(cols);
            for col_idx in 0..cols {
                let cell = &grid[line][Column(col_idx)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                text.push(cell.c);
            }
            let trimmed = text.trim_end().to_string();
            lines.push(GridRow {
                row: row_idx as u16,
                text: trimmed,
            });
        }

        let cursor = grid.cursor.point;
        GridSnapshot {
            session_id: session_id.to_string(),
            seq: self.seq,
            cols: self.cols,
            rows: self.rows,
            cursor_col: cursor.column.0 as u16,
            cursor_row: cursor.line.0.max(0) as u16,
            lines,
        }
    }

    /// Extracts up to `max_lines` of non-empty recent history + visible lines for SQLite hibernation.
    pub fn extract_tail_lines(&self, max_lines: usize) -> Vec<String> {
        let grid = self.term.grid();
        let history = grid.history_size() as i32;
        let screen = grid.screen_lines() as i32;
        let cols = grid.columns();
        let start = -history;
        let mut out = Vec::new();

        for row_i in start..screen {
            let line = Line(row_i);
            let mut text = String::with_capacity(cols);
            for col_idx in 0..cols {
                let cell = &grid[line][Column(col_idx)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                text.push(cell.c);
            }
            let trimmed = text.trim_end();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }

        if out.len() > max_lines {
            let drain_end = out.len() - max_lines;
            out.drain(..drain_end);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_ansi_output_and_extracts_tail() {
        let mut vt = HeadlessVt::new(80, 24);
        vt.feed(b"\x1b[32mhello\x1b[0m iron-term\r\nsecond line\r\n");
        let snap = vt.snapshot("s1");
        assert_eq!(snap.lines[0].text, "hello iron-term");
        assert_eq!(snap.lines[1].text, "second line");
        assert_eq!(snap.cursor_row, 2);

        let tail = vt.extract_tail_lines(10);
        assert_eq!(tail, vec!["hello iron-term", "second line"]);
    }
}
