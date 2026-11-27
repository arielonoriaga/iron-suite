use gpui::{Rgba, rgb, rgba};
use iron_proto::{AgentState, HostMode};

/// Celestial Dark & Light color tokens matching `docs/DESIGN.md`.
#[derive(Debug, Clone, Copy)]
pub struct ThemePalette {
    pub is_dark: bool,
    pub void_canvas: Rgba,
    pub deep_rail: Rgba,
    pub raised_surface: Rgba,
    pub active_row: Rgba,
    pub hairline_border: Rgba,
    pub primary_text: Rgba,
    pub muted_text: Rgba,
    pub accent_blue: Rgba,
    pub attention_coral: Rgba,
    pub caution_gold: Rgba,
    pub healthy_emerald: Rgba,
    pub review_violet: Rgba,
    pub host_teal: Rgba,
    pub error_red: Rgba,
    pub overlay_backdrop: Rgba,
    pub cursor_bg: Rgba,
    pub cursor_fg: Rgba,
}

impl ThemePalette {
    pub fn dark() -> Self {
        Self {
            is_dark: true,
            void_canvas: rgb(0x060b13),
            deep_rail: rgb(0x0b1320),
            raised_surface: rgb(0x111c2d),
            active_row: rgba(0x3b82f626),
            hairline_border: rgba(0x7296c233),
            primary_text: rgb(0xedf2f8),
            muted_text: rgb(0x7086a3),
            accent_blue: rgb(0x3b82f6),
            attention_coral: rgb(0xe8622c),
            caution_gold: rgb(0xf7bf2e),
            healthy_emerald: rgb(0x34d399),
            review_violet: rgb(0xa78bfa),
            host_teal: rgb(0x2dd4bf),
            error_red: rgb(0xf87171),
            overlay_backdrop: rgba(0x03070ecc),
            cursor_bg: rgb(0x3b82f6),
            cursor_fg: rgb(0x060b13),
        }
    }

    pub fn light() -> Self {
        Self {
            is_dark: false,
            void_canvas: rgb(0xf5f7fb),
            deep_rail: rgb(0xebf0f6),
            raised_surface: rgb(0xffffff),
            active_row: rgba(0x1d4ed81f),
            hairline_border: rgba(0x2d486c29),
            primary_text: rgb(0x111827),
            muted_text: rgb(0x64748b),
            accent_blue: rgb(0x1d4ed8),
            attention_coral: rgb(0xc2410c),
            caution_gold: rgb(0xb45309),
            healthy_emerald: rgb(0x047857),
            review_violet: rgb(0x6d28d9),
            host_teal: rgb(0x0f766e),
            error_red: rgb(0xb91c1c),
            overlay_backdrop: rgba(0x0f172a55),
            cursor_bg: rgb(0x1d4ed8),
            cursor_fg: rgb(0xffffff),
        }
    }

    pub fn for_mode(is_dark: bool) -> Self {
        if is_dark { Self::dark() } else { Self::light() }
    }

    pub fn state_color(&self, state: AgentState) -> Rgba {
        match state {
            AgentState::NeedsApproval => self.attention_coral,
            AgentState::ReviewReady => self.review_violet,
            AgentState::Failed => self.error_red,
            AgentState::Queued => self.caution_gold,
            AgentState::Running => self.healthy_emerald,
            AgentState::Hibernated => self.muted_text,
        }
    }

    pub fn host_mode_color(&self, mode: HostMode) -> Rgba {
        match mode {
            HostMode::Free => self.healthy_emerald,
            HostMode::Shared => self.caution_gold,
            HostMode::Off => self.error_red,
        }
    }
}

pub fn state_short_tag(state: AgentState) -> &'static str {
    match state {
        AgentState::NeedsApproval => "!app",
        AgentState::ReviewReady => "rev*",
        AgentState::Failed => "!err",
        AgentState::Queued => "runq",
        AgentState::Running => "live",
        AgentState::Hibernated => "0MB",
    }
}

pub fn host_mode_label(mode: HostMode) -> &'static str {
    match mode {
        HostMode::Free => "free",
        HostMode::Shared => "shared",
        HostMode::Off => "off",
    }
}
