use std::collections::HashMap;
use std::time::Duration;

use gpui::{
    App, Context, Div, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement,
    KeyDownEvent, MouseButton, ParentElement, Render, SharedString, Stateful,
    StatefulInteractiveElement, Styled, Subscription, Timer, Window, div, px,
};
use iron_proto::{
    AgentState, GridSnapshot, HostMode, HostStatus, OverheadStats, SessionSummary,
};
use tokio::sync::mpsc;

use crate::cli::SpawnMetadata;
use crate::client::{BridgeCommand, BridgeEvent, DaemonBridge};
use crate::theme::{ThemePalette, host_mode_label, state_short_tag};
use crate::vt_input::keystroke_to_vt_bytes;

const RAIL_WIDTH_PX: f32 = 236.0;
const STATUSLINE_HEIGHT_PX: f32 = 27.0;
const HAIRLINE_HEIGHT_PX: f32 = 24.0;
const GHOST_BAR_HEIGHT_PX: f32 = 28.0;
const CELL_WIDTH_PX: f32 = 7.8;
const CELL_HEIGHT_PX: f32 = 18.0;

#[derive(Debug, Clone, Default)]
struct PaneSlot {
    session_id: Option<String>,
    last_size: (u16, u16),
}

#[derive(Debug, Clone)]
struct ToastNotice {
    id: u64,
    message: String,
    is_error: bool,
}

pub struct IronTermView {
    focus_handle: FocusHandle,
    bridge: DaemonBridge,
    default_spawn: SpawnMetadata,
    palette: ThemePalette,
    mono_font_family: SharedString,
    connected: bool,
    connection_status: String,

    hosts: Vec<HostStatus>,
    sessions: Vec<SessionSummary>,
    overhead: OverheadStats,
    grids: HashMap<String, GridSnapshot>,

    panes: [PaneSlot; 2],
    focused_pane: usize,
    split_open: bool,

    rail_open: bool,
    dormant_rail_expanded: bool,
    fleet_overlay_open: bool,
    dormant_fleet_expanded: bool,

    omnibox_open: bool,
    omnibox_query: String,
    omnibox_selected: usize,

    toast: Option<ToastNotice>,
    next_toast_id: u64,

    _subscriptions: Vec<Subscription>,
}

impl Focusable for IronTermView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl IronTermView {
    pub fn new(
        bridge: DaemonBridge,
        mut event_rx: mpsc::UnboundedReceiver<BridgeEvent>,
        default_spawn: SpawnMetadata,
        start_light: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);

        let bounds_sub = cx.observe_window_bounds(window, |view, window, cx| {
            view.sync_pty_dimensions(window, cx);
        });

        // Drive UI updates directly from the background socket thread with zero polling.
        cx.spawn(async move |this, cx| {
            while let Some(event) = event_rx.recv().await {
                let updated = this.update(cx, |view, cx| {
                    view.handle_bridge_event(event, cx);
                    cx.notify();
                });
                if updated.is_err() {
                    break;
                }
            }
        })
        .detach();

        let available_fonts = cx.text_system().all_font_names();
        let font_override = std::env::var("IRON_TERM_FONT").ok();
        let mono_font_family =
            resolve_monospace_font(font_override.as_deref(), &available_fonts);

        Self {
            focus_handle,
            bridge,
            default_spawn,
            palette: ThemePalette::for_mode(!start_light),
            mono_font_family,
            connected: false,
            connection_status: "Connecting to iron-agentd...".to_string(),
            hosts: Vec::new(),
            sessions: Vec::new(),
            overhead: OverheadStats {
                rendered_ptys: 0,
                headless_live: 0,
                hibernated: 0,
                total_live_ram_mb: 0,
            },
            grids: HashMap::new(),
            panes: [PaneSlot::default(), PaneSlot::default()],
            focused_pane: 0,
            split_open: false,
            rail_open: false,
            dormant_rail_expanded: false,
            fleet_overlay_open: false,
            dormant_fleet_expanded: false,
            omnibox_open: false,
            omnibox_query: String::new(),
            omnibox_selected: 0,
            toast: None,
            next_toast_id: 1,
            _subscriptions: vec![bounds_sub],
        }
    }

    fn handle_bridge_event(&mut self, event: BridgeEvent, cx: &mut Context<Self>) {
        match event {
            BridgeEvent::Connected => {
                self.connected = true;
                self.connection_status = "Connected".to_string();
            }
            BridgeEvent::Disconnected(reason) => {
                self.connected = false;
                self.connection_status = reason.clone();
                self.show_toast(format!("Daemon disconnected: {reason}"), true, cx);
            }
            BridgeEvent::FleetUpdated {
                hosts,
                sessions,
                overhead,
            } => {
                self.hosts = hosts;
                self.sessions = sessions;
                self.overhead = overhead;
            }
            BridgeEvent::GridUpdated(snapshot) => {
                if self.is_session_visible(&snapshot.session_id) {
                    self.grids.insert(snapshot.session_id.clone(), snapshot);
                }
            }
            BridgeEvent::PaneAttached {
                pane_slot,
                snapshot,
            } => {
                let sid = snapshot.session_id.clone();
                if pane_slot >= 1 && !self.split_open {
                    // Split was closed while attach was in flight: drop hidden GPU attachment.
                    if self.panes[0].session_id.as_deref() != Some(sid.as_str()) {
                        self.bridge
                            .send(BridgeCommand::DetachSession { session_id: sid });
                    }
                    return;
                }
                let slot = pane_slot.min(1);
                if let Some(ref expected) = self.panes[slot].session_id
                    && expected != &sid
                {
                    // Superseded by a newer pane switch while attach was in flight.
                    if !self.is_session_visible(&sid) {
                        self.bridge
                            .send(BridgeCommand::DetachSession { session_id: sid });
                    }
                    return;
                }
                self.panes[slot].session_id = Some(sid.clone());
                self.panes[slot].last_size = (snapshot.cols, snapshot.rows);
                self.grids.insert(sid, snapshot);
            }
            BridgeEvent::SessionSpawned { pane_slot, session } => {
                if pane_slot >= 1 && !self.split_open {
                    if !self.sessions.iter().any(|s| s.id == session.id) {
                        self.sessions.insert(0, session);
                    }
                    return;
                }
                let slot = pane_slot.min(1);
                self.panes[slot].session_id = Some(session.id.clone());
                if !self.sessions.iter().any(|s| s.id == session.id) {
                    self.sessions.insert(0, session);
                }
            }
            BridgeEvent::PromptRaised { session_id, prompt } => {
                if let Some(s) = self.sessions.iter_mut().find(|s| s.id == session_id) {
                    s.prompt = Some(prompt.clone());
                }
                self.show_toast(format!("Action required: {}", prompt.title), false, cx);
            }
            BridgeEvent::MoveBlocked { session_id, reason } => {
                let prefix = self
                    .session_by_id(&session_id)
                    .map(|s| format!("{}: ", s.title))
                    .unwrap_or_default();
                self.show_toast(format!("[LOCK] {prefix}{reason}"), true, cx);
            }
            BridgeEvent::InspectionLoaded(inspection) => {
                self.show_toast(
                    format!(
                        "{}: {} todos, {} journal entries",
                        inspection.session.title,
                        inspection.todos.len(),
                        inspection.recent_journal.len()
                    ),
                    false,
                    cx,
                );
            }
            BridgeEvent::Toast { message, is_error } => {
                self.show_toast(message, is_error, cx);
            }
        }
    }

    fn show_toast(&mut self, message: String, is_error: bool, cx: &mut Context<Self>) {
        let id = self.next_toast_id;
        self.next_toast_id = self.next_toast_id.wrapping_add(1).max(1);
        self.toast = Some(ToastNotice {
            id,
            message,
            is_error,
        });
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_secs(5)).await;
            let _ = this.update(cx, |view, cx| {
                if view.toast.as_ref().is_some_and(|t| t.id == id) {
                    view.toast = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn is_session_visible(&self, session_id: &str) -> bool {
        if self.panes[0].session_id.as_deref() == Some(session_id) {
            return true;
        }
        self.split_open && self.panes[1].session_id.as_deref() == Some(session_id)
    }

    fn other_pane_session(&self, pane_slot: usize) -> Option<&str> {
        if !self.split_open {
            return None;
        }
        let other = if pane_slot == 0 { 1 } else { 0 };
        self.panes[other].session_id.as_deref()
    }

    fn session_by_id(&self, id: &str) -> Option<&SessionSummary> {
        self.sessions.iter().find(|s| s.id == id)
    }

    fn focused_session(&self) -> Option<&SessionSummary> {
        let sid = self.panes[self.focused_pane].session_id.as_deref()?;
        self.session_by_id(sid)
    }

    fn compute_pane_grid_size(&self, window: &Window, has_ghost_bar: bool) -> (u16, u16) {
        let vp = window.viewport_size();
        let total_w = f32::from(vp.width);
        let total_h = f32::from(vp.height);

        let rail_w = if self.rail_open { RAIL_WIDTH_PX } else { 0.0 };
        let workspace_w = (total_w - rail_w).max(160.0);
        let pane_w = if self.split_open {
            ((workspace_w - 1.0) * 0.5).max(120.0)
        } else {
            workspace_w
        };

        let ghost_h = if has_ghost_bar {
            GHOST_BAR_HEIGHT_PX
        } else {
            0.0
        };
        let pane_h =
            (total_h - STATUSLINE_HEIGHT_PX - HAIRLINE_HEIGHT_PX - ghost_h - 12.0).max(90.0);

        let cols = (((pane_w - 16.0).max(80.0)) / CELL_WIDTH_PX).floor() as u16;
        let rows = (pane_h / CELL_HEIGHT_PX).floor() as u16;
        (cols.clamp(24, 400), rows.clamp(6, 160))
    }

    fn sync_pty_dimensions(&mut self, window: &Window, _cx: &mut Context<Self>) {
        let vp = window.viewport_size();
        let total_w = f32::from(vp.width);
        let total_h = f32::from(vp.height);
        if !total_w.is_finite() || !total_h.is_finite() || total_w < 1.0 || total_h < 1.0 {
            return;
        }

        let active_slots = if self.split_open { 2 } else { 1 };
        for slot in 0..active_slots {
            let Some(sid) = self.panes[slot].session_id.clone() else {
                continue;
            };
            if self
                .session_by_id(&sid)
                .is_some_and(|s| s.state == AgentState::Hibernated)
            {
                continue;
            }
            let has_ghost = self.session_by_id(&sid).is_some_and(session_has_ghost_bar);
            let (cols, rows) = self.compute_pane_grid_size(window, has_ghost);
            if self.panes[slot].last_size != (cols, rows) {
                self.panes[slot].last_size = (cols, rows);
                self.bridge.send(BridgeCommand::PtyResize {
                    session_id: sid,
                    cols,
                    rows,
                });
            }
        }
    }

    fn wake_and_attach_session_in_pane(
        &mut self,
        pane_slot: usize,
        session_id: String,
        rebase_onto_main: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let slot = pane_slot.min(1);
        let other = self.other_pane_session(slot).map(ToOwned::to_owned);
        let detach_old = self.panes[slot]
            .session_id
            .clone()
            .filter(|old| old != &session_id && other.as_deref() != Some(old.as_str()));
        if let Some(ref old_id) = detach_old {
            self.grids.remove(old_id);
        }

        let (cols, rows) = self.compute_pane_grid_size(window, false);
        self.panes[slot].session_id = Some(session_id.clone());
        self.panes[slot].last_size = (cols, rows);
        self.focused_pane = slot;

        self.bridge.send(BridgeCommand::WakeAndAttach {
            pane_slot: slot,
            detach_old,
            session_id,
            rebase_onto_main,
            cols,
            rows,
        });
        cx.notify();
    }

    fn attach_session_in_pane(
        &mut self,
        pane_slot: usize,
        session_id: String,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let is_hibernated = self
            .session_by_id(&session_id)
            .is_some_and(|s| s.state == AgentState::Hibernated);
        if is_hibernated {
            self.wake_and_attach_session_in_pane(pane_slot, session_id, false, window, cx);
            return;
        }

        let slot = pane_slot.min(1);
        let other = self.other_pane_session(slot).map(ToOwned::to_owned);
        let detach_old = self.panes[slot]
            .session_id
            .clone()
            .filter(|old| old != &session_id && other.as_deref() != Some(old.as_str()));
        if let Some(ref old_id) = detach_old {
            self.grids.remove(old_id);
        }

        let has_ghost = self
            .session_by_id(&session_id)
            .is_some_and(session_has_ghost_bar);
        let (cols, rows) = self.compute_pane_grid_size(window, has_ghost);

        self.panes[slot].session_id = Some(session_id.clone());
        self.panes[slot].last_size = (cols, rows);
        self.focused_pane = slot;

        self.bridge.send(BridgeCommand::AttachPane {
            pane_slot: slot,
            detach_old,
            session_id,
            cols,
            rows,
        });
        cx.notify();
    }

    fn toggle_rail(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.rail_open = !self.rail_open;
        self.sync_pty_dimensions(window, cx);
        cx.notify();
    }

    fn toggle_split(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.split_open {
            self.split_open = false;
            self.focused_pane = 0;
            if let Some(old_sid) = self.panes[1].session_id.take()
                && self.panes[0].session_id.as_deref() != Some(old_sid.as_str())
            {
                self.bridge.send(BridgeCommand::DetachSession {
                    session_id: old_sid.clone(),
                });
                self.grids.remove(&old_sid);
            }
            self.sync_pty_dimensions(window, cx);
            cx.notify();
            return;
        }

        self.split_open = true;
        let pane0_sid = self.panes[0].session_id.as_deref();
        let next_live = self
            .sessions
            .iter()
            .find(|s| s.state.is_live() && Some(s.id.as_str()) != pane0_sid)
            .map(|s| s.id.clone());

        let (cols, rows) = self.compute_pane_grid_size(window, false);
        if let Some(sid) = next_live {
            self.panes[1].session_id = Some(sid.clone());
            self.panes[1].last_size = (cols, rows);
            self.focused_pane = 1;
            self.bridge.send(BridgeCommand::AttachPane {
                pane_slot: 1,
                detach_old: None,
                session_id: sid,
                cols,
                rows,
            });
        } else {
            self.focused_pane = 1;
            self.spawn_new_session_into_pane(1, None, window, cx);
        }
        self.sync_pty_dimensions(window, cx);
        cx.notify();
    }

    fn spawn_new_session_into_pane(
        &mut self,
        pane_slot: usize,
        custom_title: Option<String>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let slot = pane_slot.min(1);
        let other = self.other_pane_session(slot).map(ToOwned::to_owned);
        let detach_old = self.panes[slot]
            .session_id
            .clone()
            .filter(|old| other.as_deref() != Some(old.as_str()));
        if let Some(ref old_id) = detach_old {
            self.grids.remove(old_id);
        }
        let (cols, rows) = self.compute_pane_grid_size(window, false);

        let title = custom_title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                let count = self.sessions.len() + 1;
                format!("{} · shell #{count}", self.default_spawn.project)
            });

        self.bridge.send(BridgeCommand::SpawnAndAttach {
            pane_slot: slot,
            detach_old,
            title,
            host_id: None,
            project: self.default_spawn.project.clone(),
            worktree_path: self.default_spawn.worktree_path.clone(),
            cli: "shell".to_string(),
            command: Vec::new(),
            cols,
            rows,
        });
        cx.notify();
    }

    fn hibernate_session(&mut self, session_id: String, cx: &mut Context<Self>) {
        // Detach if currently rendered so daemon drops GPU attachment immediately.
        if self.is_session_visible(&session_id) {
            self.bridge.send(BridgeCommand::DetachSession {
                session_id: session_id.clone(),
            });
            self.grids.remove(&session_id);
        }
        self.bridge.send(BridgeCommand::HibernateSession {
            session_id,
            checkpoint: None,
        });
        cx.notify();
    }

    fn trigger_ghost_action(&mut self, index: usize, window: &Window, cx: &mut Context<Self>) {
        let Some(session) = self.focused_session().cloned() else {
            return;
        };

        if let Some(ref prompt) = session.prompt {
            if let Some(action) = prompt.actions.get(index) {
                self.bridge.send(BridgeCommand::ResolvePrompt {
                    session_id: session.id,
                    action_id: action.id.clone(),
                    custom_reply: None,
                });
                cx.notify();
            }
            return;
        }

        if session.state == AgentState::Hibernated {
            let rebase = index == 0 && session.git_behind_main > 0;
            self.wake_and_attach_session_in_pane(
                self.focused_pane,
                session.id,
                rebase,
                window,
                cx,
            );
        }
    }

    fn omnibox_matches(&self) -> Vec<SessionSummary> {
        let q = self.omnibox_query.trim().to_ascii_lowercase();
        if q.is_empty() {
            return self.sessions.iter().take(12).cloned().collect();
        }
        self.sessions
            .iter()
            .filter(|s| {
                s.title.to_ascii_lowercase().contains(&q)
                    || s.project.to_ascii_lowercase().contains(&q)
                    || s.host_id.to_ascii_lowercase().contains(&q)
                    || s.git_branch.to_ascii_lowercase().contains(&q)
                    || s.cli.to_ascii_lowercase().contains(&q)
                    || s.checkpoint.to_ascii_lowercase().contains(&q)
            })
            .take(12)
            .cloned()
            .collect()
    }

    fn execute_omnibox_selection(&mut self, window: &Window, cx: &mut Context<Self>) {
        let matches = self.omnibox_matches();
        let selected = self.omnibox_selected;
        let query = self.omnibox_query.trim().to_string();

        self.omnibox_open = false;
        self.omnibox_query.clear();
        self.omnibox_selected = 0;

        if let Some(session) = matches.get(selected) {
            self.attach_session_in_pane(self.focused_pane, session.id.clone(), window, cx);
        } else {
            let custom = (!query.is_empty()).then_some(query);
            self.spawn_new_session_into_pane(self.focused_pane, custom, window, cx);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        let focused = self.focused_session();
        let has_ghost_bar = focused.is_some_and(session_has_ghost_bar);
        let is_hibernated = focused.is_some_and(|s| s.state == AgentState::Hibernated);

        match classify_key_action(
            &ks.key,
            ks.modifiers.control,
            ks.modifiers.alt,
            ks.modifiers.shift,
            ks.modifiers.platform,
            self.omnibox_open,
            self.fleet_overlay_open,
            self.split_open,
            has_ghost_bar,
            is_hibernated,
        ) {
            KeyAction::ToggleRail => self.toggle_rail(window, cx),
            KeyAction::ToggleFleetOverlay => {
                self.fleet_overlay_open = !self.fleet_overlay_open;
                if self.fleet_overlay_open {
                    self.omnibox_open = false;
                    self.bridge.send(BridgeCommand::ListFleet);
                }
                cx.notify();
            }
            KeyAction::CloseFleetOverlay => {
                self.fleet_overlay_open = false;
                cx.notify();
            }
            KeyAction::ToggleOmnibox => {
                self.omnibox_open = !self.omnibox_open;
                if self.omnibox_open {
                    self.fleet_overlay_open = false;
                    self.omnibox_query.clear();
                    self.omnibox_selected = 0;
                }
                cx.notify();
            }
            KeyAction::OmniboxInput => self.handle_omnibox_key(event, window, cx),
            KeyAction::ToggleSplit => self.toggle_split(window, cx),
            KeyAction::FocusPane(slot) => {
                self.focused_pane = slot.min(1);
                cx.notify();
            }
            KeyAction::GhostAction(idx) => self.trigger_ghost_action(idx, window, cx),
            KeyAction::ForwardEof => {
                if let Some(sid) = self.panes[self.focused_pane].session_id.clone()
                    && self
                        .session_by_id(&sid)
                        .is_none_or(|s| s.state != AgentState::Hibernated)
                {
                    self.bridge.send(BridgeCommand::PtyInput {
                        session_id: sid,
                        bytes: vec![0x04],
                    });
                }
            }
            KeyAction::PasteClipboard => {
                if let Some(sid) = self.panes[self.focused_pane].session_id.clone()
                    && self
                        .session_by_id(&sid)
                        .is_none_or(|s| s.state != AgentState::Hibernated)
                    && let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
                    && !text.is_empty()
                {
                    self.bridge.send(BridgeCommand::PtyInput {
                        session_id: sid,
                        bytes: text.into_bytes(),
                    });
                }
            }
            KeyAction::ForwardPty => {
                if let Some(sid) = self.panes[self.focused_pane].session_id.clone()
                    && self
                        .session_by_id(&sid)
                        .is_none_or(|s| s.state != AgentState::Hibernated)
                    && let Some(bytes) = keystroke_to_vt_bytes(ks)
                {
                    self.bridge.send(BridgeCommand::PtyInput {
                        session_id: sid,
                        bytes,
                    });
                }
            }
            KeyAction::Ignore => {}
        }
    }

    fn handle_omnibox_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ks = &event.keystroke;
        let key_lower = ks.key.to_ascii_lowercase();
        let total_items = self.omnibox_matches().len() + 1;

        match key_lower.as_str() {
            "escape" => {
                self.omnibox_open = false;
                self.omnibox_query.clear();
                self.omnibox_selected = 0;
            }
            "enter" | "return" => {
                self.execute_omnibox_selection(window, cx);
                return;
            }
            "backspace" => {
                self.omnibox_query.pop();
                self.omnibox_selected = 0;
            }
            "up" => {
                if self.omnibox_selected > 0 {
                    self.omnibox_selected -= 1;
                } else {
                    self.omnibox_selected = total_items.saturating_sub(1);
                }
            }
            "down" => {
                self.omnibox_selected = (self.omnibox_selected + 1) % total_items.max(1);
            }
            "space" => {
                self.omnibox_query.push(' ');
                self.omnibox_selected = 0;
            }
            _ if !ks.modifiers.control && !ks.modifiers.alt && !ks.modifiers.platform => {
                if let Some(ref ch) = ks.key_char
                    && !ch.is_empty()
                    && !ch.chars().all(char::is_control)
                {
                    self.omnibox_query.push_str(ch);
                    self.omnibox_selected = 0;
                } else if ks.key.chars().count() == 1 {
                    self.omnibox_query.push_str(&ks.key);
                    self.omnibox_selected = 0;
                }
            }
            _ => {}
        }
        cx.notify();
    }

    fn render_whisper_rail(&self, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let urgent: Vec<SessionSummary> = self
            .sessions
            .iter()
            .filter(|s| s.state.is_urgent())
            .cloned()
            .collect();
        let active: Vec<SessionSummary> = self
            .sessions
            .iter()
            .filter(|s| s.state.is_live() && !s.state.is_urgent())
            .cloned()
            .collect();
        let dormant: Vec<SessionSummary> = self
            .sessions
            .iter()
            .filter(|s| s.state == AgentState::Hibernated)
            .cloned()
            .collect();

        let active_ram: u32 = active.iter().map(|s| s.ram_mb).sum();

        let mut list = div()
            .id("whisper-rail-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .py_1();

        // Section 1: NEEDS YOU
        if !urgent.is_empty() {
            list = list.child(
                div()
                    .px_2()
                    .py_1()
                    .text_size(px(10.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.attention_coral)
                    .child(format!("NEEDS YOU ({})", urgent.len())),
            );
            for s in urgent {
                list = list.child(self.render_rail_row(&s, cx));
            }
        }

        // Section 2: ACTIVE
        list = list.child(
            div()
                .px_2()
                .py_1()
                .text_size(px(10.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.muted_text)
                .child(format!("ACTIVE · {}MB ({})", active_ram, active.len())),
        );
        if active.is_empty() {
            list = list.child(
                div()
                    .px_2()
                    .py_1()
                    .text_size(px(11.0))
                    .text_color(p.muted_text)
                    .child("No active sessions"),
            );
        } else {
            for s in active {
                list = list.child(self.render_rail_row(&s, cx));
            }
        }

        // Section 3: Collapsible DORMANT (0MB)
        let arrow = if self.dormant_rail_expanded {
            "▾"
        } else {
            "▸"
        };
        list = list.child(
            div()
                .id("rail-dormant-toggle")
                .cursor_pointer()
                .px_2()
                .py_1()
                .mt_1()
                .text_size(px(10.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.muted_text)
                .on_click(cx.listener(|view, _, _, cx| {
                    view.dormant_rail_expanded = !view.dormant_rail_expanded;
                    cx.notify();
                }))
                .child(format!("{arrow} DORMANT (0MB) ({})", dormant.len())),
        );
        if self.dormant_rail_expanded {
            for s in dormant {
                list = list.child(self.render_rail_row(&s, cx));
            }
        }

        div()
            .w(px(RAIL_WIDTH_PX))
            .flex_shrink_0()
            .h_full()
            .bg(p.deep_rail)
            .border_r_1()
            .border_color(p.hairline_border)
            .flex()
            .flex_col()
            .child(
                div()
                    .id("rail-omnibox-trigger")
                    .cursor_pointer()
                    .h(px(HAIRLINE_HEIGHT_PX))
                    .px_2()
                    .border_b_1()
                    .border_color(p.hairline_border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(11.0))
                    .text_color(p.muted_text)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.omnibox_open = true;
                        view.fleet_overlay_open = false;
                        view.omnibox_query.clear();
                        view.omnibox_selected = 0;
                        cx.notify();
                    }))
                    .child("/ filter or spawn…")
                    .child("Ctrl+K"),
            )
            .child(list)
    }

    fn render_rail_row(&self, s: &SessionSummary, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = self.palette;
        let is_attached = self.is_session_visible(&s.id);
        let dot_color = p.state_color(s.state);
        let sid = s.id.clone();

        let tag = if s.state.is_urgent() {
            state_short_tag(s.state).to_string()
        } else if s.state == AgentState::Hibernated {
            "0MB".to_string()
        } else {
            format!("@{}", short_host(&s.host_id))
        };

        div()
            .id(SharedString::from(format!("rail-row-{}", s.id)))
            .cursor_pointer()
            .px_2()
            .py(px(4.0))
            .flex()
            .items_center()
            .justify_between()
            .gap_1()
            .bg(if is_attached {
                p.active_row
            } else {
                p.deep_rail
            })
            .border_l_2()
            .border_color(if is_attached {
                p.accent_blue
            } else {
                p.deep_rail
            })
            .on_click(cx.listener(move |view, _, window, cx| {
                view.attach_session_in_pane(view.focused_pane, sid.clone(), window, cx);
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .w(px(7.0))
                            .h(px(7.0))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(dot_color),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.5))
                            .text_color(if s.state == AgentState::Hibernated {
                                p.muted_text
                            } else {
                                p.primary_text
                            })
                            .child(s.title.clone()),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(10.0))
                    .text_color(if s.state.is_urgent() {
                        dot_color
                    } else {
                        p.muted_text
                    })
                    .child(tag),
            )
    }

    fn render_pane(&self, pane_slot: usize, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let is_focused = self.focused_pane == pane_slot;
        let sid = self.panes[pane_slot].session_id.as_deref();
        let session = sid.and_then(|id| self.session_by_id(id));
        let snapshot = sid.and_then(|id| self.grids.get(id));

        let dot_color = session
            .map(|s| p.state_color(s.state))
            .unwrap_or(p.muted_text);

        let left_meta = match session {
            Some(s) => format!("{} @{} · {} · {}", s.title, s.host_id, s.cli, s.phase),
            None => self.connection_status.clone(),
        };

        let right_meta = match session {
            Some(s) => format!("{} · {}MB", s.git_branch, s.ram_mb),
            None => "0MB".to_string(),
        };

        // 24px pane hairline
        let mut hairline_right = div()
            .flex()
            .items_center()
            .gap_2()
            .flex_shrink_0()
            .text_size(px(11.0))
            .text_color(p.muted_text)
            .child(right_meta);

        if let Some(s) = session {
            let info_sid = s.id.clone();
            hairline_right = hairline_right.child(
                div()
                    .id(SharedString::from(format!("pane-{pane_slot}-info")))
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(1.0))
                    .rounded_sm()
                    .border_1()
                    .border_color(p.hairline_border)
                    .text_size(px(10.5))
                    .text_color(p.muted_text)
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.bridge.send(BridgeCommand::InspectSession {
                            session_id: info_sid.clone(),
                        });
                        cx.notify();
                    }))
                    .child("info"),
            );
            if s.state.is_live() {
                let sleep_sid = s.id.clone();
                hairline_right = hairline_right.child(
                    div()
                        .id(SharedString::from(format!("pane-{pane_slot}-sleep")))
                        .cursor_pointer()
                        .px(px(6.0))
                        .py(px(1.0))
                        .rounded_sm()
                        .border_1()
                        .border_color(p.hairline_border)
                        .text_size(px(10.5))
                        .text_color(p.muted_text)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.hibernate_session(sleep_sid.clone(), cx);
                        }))
                        .child("sleep"),
                );
            }
        }

        let hairline = div()
            .h(px(HAIRLINE_HEIGHT_PX))
            .flex_shrink_0()
            .px_2()
            .bg(if is_focused {
                p.deep_rail
            } else {
                p.void_canvas
            })
            .border_b_1()
            .border_color(if is_focused && self.split_open {
                p.accent_blue
            } else {
                p.hairline_border
            })
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .w(px(7.0))
                            .h(px(7.0))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(dot_color),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.5))
                            .text_color(if is_focused {
                                p.primary_text
                            } else {
                                p.muted_text
                            })
                            .child(left_meta),
                    ),
            )
            .child(hairline_right);

        // Terminal Grid body
        let grid_view = self.render_terminal_grid(session, snapshot, is_focused);

        let mut pane = div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .bg(p.void_canvas)
            .flex()
            .flex_col()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |view, _, window, cx| {
                    view.focused_pane = pane_slot;
                    view.focus_handle.focus(window);
                    cx.notify();
                }),
            )
            .child(hairline)
            .child(grid_view);

        // 1-Line Ghost Action Bar (ONLY when prompt is present OR session is Hibernated)
        if let Some(s) = session
            && session_has_ghost_bar(s)
        {
            pane = pane.child(self.render_ghost_action_bar(pane_slot, s, cx));
        }

        pane
    }

    fn render_terminal_grid(
        &self,
        session: Option<&SessionSummary>,
        snapshot: Option<&GridSnapshot>,
        is_focused: bool,
    ) -> Div {
        let p = self.palette;
        let mut body = div()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_hidden()
            .bg(p.void_canvas)
            .px_2()
            .py_1()
            .flex()
            .flex_col()
            .text_size(px(13.0))
            .line_height(px(CELL_HEIGHT_PX));

        if let Some(s) = session
            && s.state == AgentState::Hibernated
        {
            return body
                .justify_center()
                .items_center()
                .gap_1()
                .child(
                    div()
                        .text_size(px(13.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.primary_text)
                        .child(format!("{} — Hibernated (0 MB RAM)", s.title)),
                )
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(p.muted_text)
                        .child(format!("Checkpoint: {}", s.checkpoint)),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(p.accent_blue)
                        .child("Press [1] or click the Ghost Action Bar below to wake PTY"),
                );
        }

        let Some(snap) = snapshot else {
            return body.child(
                div()
                    .text_color(p.muted_text)
                    .child(self.connection_status.clone()),
            );
        };

        let show_cursor = is_focused && !self.omnibox_open && !self.fleet_overlay_open;
        let mut line_map: HashMap<u16, &str> = HashMap::with_capacity(snap.lines.len());
        for row in &snap.lines {
            line_map.insert(row.row, row.text.as_str());
        }

        for r in 0..snap.rows {
            let text = line_map.get(&r).copied().unwrap_or("");
            if show_cursor && r == snap.cursor_row {
                let (before, cur, after) = split_line_at_cursor(text, snap.cursor_col);
                let mut row_div = div()
                    .h(px(CELL_HEIGHT_PX))
                    .w_full()
                    .flex()
                    .flex_row()
                    .whitespace_nowrap();
                if !before.is_empty() {
                    row_div = row_div.child(div().text_color(p.primary_text).child(before));
                }
                row_div = row_div.child(
                    div()
                        .bg(p.cursor_bg)
                        .text_color(p.cursor_fg)
                        .child(cur),
                );
                if !after.is_empty() {
                    row_div = row_div.child(div().text_color(p.primary_text).child(after));
                }
                body = body.child(row_div);
            } else {
                let display = if text.is_empty() {
                    " ".to_string()
                } else {
                    text.to_string()
                };
                body = body.child(
                    div()
                        .h(px(CELL_HEIGHT_PX))
                        .w_full()
                        .whitespace_nowrap()
                        .text_color(p.primary_text)
                        .child(display),
                );
            }
        }

        body
    }

    fn render_ghost_action_bar(
        &self,
        pane_slot: usize,
        s: &SessionSummary,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = self.palette;
        let accent = if s.prompt.is_some() {
            p.state_color(s.state)
        } else {
            p.accent_blue
        };

        let mut actions_row = div().flex().items_center().gap_2().flex_shrink_0();

        if let Some(ref prompt) = s.prompt {
            for (idx, action) in prompt.actions.iter().take(3).enumerate() {
                let sid = s.id.clone();
                let aid = action.id.clone();
                let btn_bg = if action.is_primary {
                    p.accent_blue
                } else if action.is_destructive {
                    p.error_red
                } else {
                    p.deep_rail
                };
                let btn_fg = if action.is_primary || action.is_destructive {
                    rgb_white()
                } else {
                    p.primary_text
                };

                actions_row = actions_row.child(
                    div()
                        .id(SharedString::from(format!("ghost-{pane_slot}-act-{idx}")))
                        .cursor_pointer()
                        .px_2()
                        .py(px(2.0))
                        .rounded_sm()
                        .bg(btn_bg)
                        .border_1()
                        .border_color(p.hairline_border)
                        .text_size(px(11.0))
                        .text_color(btn_fg)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.bridge.send(BridgeCommand::ResolvePrompt {
                                session_id: sid.clone(),
                                action_id: aid.clone(),
                                custom_reply: None,
                            });
                            cx.notify();
                        }))
                        .child(format!("[{}] {}", idx + 1, action.label)),
                );
            }

            let summary = if prompt.command.trim().is_empty() {
                prompt.title.clone()
            } else {
                format!("{} · {}", prompt.title, prompt.command)
            };

            return div()
                .h(px(GHOST_BAR_HEIGHT_PX))
                .flex_shrink_0()
                .px_2()
                .bg(p.raised_surface)
                .border_t_1()
                .border_color(accent)
                .flex()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .truncate()
                        .min_w_0()
                        .flex_1()
                        .text_size(px(11.5))
                        .text_color(accent)
                        .child(summary),
                )
                .child(actions_row);
        }

        // Hibernated Ghost Action Bar
        let sid_wake_rebase = s.id.clone();
        let sid_wake = s.id.clone();
        let show_rebase = s.git_behind_main > 0;

        if show_rebase {
            actions_row = actions_row
                .child(
                    div()
                        .id(SharedString::from(format!("ghost-{pane_slot}-wake-rebase")))
                        .cursor_pointer()
                        .px_2()
                        .py(px(2.0))
                        .rounded_sm()
                        .bg(p.accent_blue)
                        .text_size(px(11.0))
                        .text_color(rgb_white())
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.wake_and_attach_session_in_pane(
                                pane_slot,
                                sid_wake_rebase.clone(),
                                true,
                                window,
                                cx,
                            );
                        }))
                        .child(format!("[1] Wake & rebase ({} behind)", s.git_behind_main)),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("ghost-{pane_slot}-wake-plain")))
                        .cursor_pointer()
                        .px_2()
                        .py(px(2.0))
                        .rounded_sm()
                        .bg(p.deep_rail)
                        .border_1()
                        .border_color(p.hairline_border)
                        .text_size(px(11.0))
                        .text_color(p.primary_text)
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.wake_and_attach_session_in_pane(
                                pane_slot,
                                sid_wake.clone(),
                                false,
                                window,
                                cx,
                            );
                        }))
                        .child("[2] Wake PTY"),
                );
        } else {
            actions_row = actions_row.child(
                div()
                    .id(SharedString::from(format!("ghost-{pane_slot}-wake-only")))
                    .cursor_pointer()
                    .px_2()
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(p.accent_blue)
                    .text_size(px(11.0))
                    .text_color(rgb_white())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.wake_and_attach_session_in_pane(
                            pane_slot,
                            sid_wake.clone(),
                            false,
                            window,
                            cx,
                        );
                    }))
                    .child("[1] Wake PTY"),
            );
        }

        div()
            .h(px(GHOST_BAR_HEIGHT_PX))
            .flex_shrink_0()
            .px_2()
            .bg(p.raised_surface)
            .border_t_1()
            .border_color(accent)
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(
                div()
                    .truncate()
                    .min_w_0()
                    .flex_1()
                    .text_size(px(11.5))
                    .text_color(p.muted_text)
                    .child(format!("Dormant · {}", s.checkpoint)),
            )
            .child(actions_row)
    }

    fn render_statusline(&self, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let urgent_count = self.sessions.iter().filter(|s| s.state.is_urgent()).count();
        let active_label = self
            .focused_session()
            .map(|s| format!("{} ({})", s.title, s.git_branch))
            .unwrap_or_else(|| self.connection_status.clone());

        let left = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .child(
                div()
                    .id("status-rail-btn")
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(if self.rail_open {
                        p.active_row
                    } else {
                        p.raised_surface
                    })
                    .border_1()
                    .border_color(p.hairline_border)
                    .text_size(px(11.0))
                    .text_color(p.primary_text)
                    .on_click(cx.listener(|view, _, window, cx| {
                        view.toggle_rail(window, cx);
                    }))
                    .child("rail Ctrl+\\"),
            )
            .child(
                div()
                    .id("status-fleet-btn")
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(if self.fleet_overlay_open {
                        p.active_row
                    } else {
                        p.raised_surface
                    })
                    .border_1()
                    .border_color(if urgent_count > 0 {
                        p.attention_coral
                    } else {
                        p.hairline_border
                    })
                    .text_size(px(11.0))
                    .text_color(if urgent_count > 0 {
                        p.attention_coral
                    } else {
                        p.primary_text
                    })
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.fleet_overlay_open = !view.fleet_overlay_open;
                        if view.fleet_overlay_open {
                            view.omnibox_open = false;
                            view.bridge.send(BridgeCommand::ListFleet);
                        }
                        cx.notify();
                    }))
                    .child(format!("{urgent_count} urgent · Fleet Ctrl+B")),
            )
            .child(
                div()
                    .id("status-split-btn")
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(if self.split_open {
                        p.active_row
                    } else {
                        p.raised_surface
                    })
                    .border_1()
                    .border_color(p.hairline_border)
                    .text_size(px(11.0))
                    .text_color(p.primary_text)
                    .on_click(cx.listener(|view, _, window, cx| {
                        view.toggle_split(window, cx);
                    }))
                    .child("split Ctrl+D"),
            )
            .child(
                div()
                    .truncate()
                    .ml_1()
                    .text_size(px(11.0))
                    .text_color(p.muted_text)
                    .child(active_label),
            );

        let overhead_text = format!(
            "● {} GPU · {} bg · {} asleep · {}MB",
            self.overhead.rendered_ptys,
            self.overhead.headless_live,
            self.overhead.hibernated,
            self.overhead.total_live_ram_mb
        );

        let mut right = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .flex_shrink_0()
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(if self.connected {
                        p.healthy_emerald
                    } else {
                        p.error_red
                    })
                    .child(overhead_text),
            );

        for host in &self.hosts {
            let color = p.host_mode_color(host.mode);
            let label = match host.mode {
                HostMode::Free => format!("{} {}%", short_host(&host.id), host.cpu_pct),
                HostMode::Shared => format!("{} shared", short_host(&host.id)),
                HostMode::Off => format!("{} off", short_host(&host.id)),
            };
            right = right.child(
                div()
                    .id(SharedString::from(format!("status-host-{}", host.id)))
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(p.raised_surface)
                    .border_1()
                    .border_color(p.hairline_border)
                    .text_size(px(10.5))
                    .text_color(color)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.fleet_overlay_open = true;
                        view.omnibox_open = false;
                        view.bridge.send(BridgeCommand::ListFleet);
                        cx.notify();
                    }))
                    .child(label),
            );
        }

        right = right
            .child(
                div()
                    .id("status-theme-btn")
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(p.raised_surface)
                    .border_1()
                    .border_color(p.hairline_border)
                    .text_size(px(10.5))
                    .text_color(p.muted_text)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.palette = ThemePalette::for_mode(!view.palette.is_dark);
                        cx.notify();
                    }))
                    .child(if p.is_dark { "dark" } else { "light" }),
            )
            .child(
                div()
                    .id("status-omnibox-btn")
                    .cursor_pointer()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(p.raised_surface)
                    .border_1()
                    .border_color(p.hairline_border)
                    .text_size(px(10.5))
                    .text_color(p.accent_blue)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.omnibox_open = true;
                        view.fleet_overlay_open = false;
                        view.omnibox_query.clear();
                        view.omnibox_selected = 0;
                        cx.notify();
                    }))
                    .child("Ctrl+K"),
            );

        div()
            .h(px(STATUSLINE_HEIGHT_PX))
            .flex_shrink_0()
            .w_full()
            .px_2()
            .bg(p.deep_rail)
            .border_t_1()
            .border_color(p.hairline_border)
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(left)
            .child(right)
    }

    fn render_fleet_overlay(&self, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let urgent: Vec<SessionSummary> = self
            .sessions
            .iter()
            .filter(|s| s.state.is_urgent())
            .cloned()
            .collect();
        let live: Vec<SessionSummary> = self
            .sessions
            .iter()
            .filter(|s| s.state.is_live())
            .cloned()
            .collect();
        let dormant: Vec<SessionSummary> = self
            .sessions
            .iter()
            .filter(|s| s.state == AgentState::Hibernated)
            .cloned()
            .collect();

        // Host cards row
        let mut hosts_row = div().flex().flex_row().gap_2().w_full();
        for host in &self.hosts {
            let mut mode_btns = div().flex().items_center().gap_1();
            for mode in [HostMode::Free, HostMode::Shared, HostMode::Off] {
                let is_active = host.mode == mode;
                let host_id = host.id.clone();
                mode_btns = mode_btns.child(
                    div()
                        .id(SharedString::from(format!(
                            "host-{}-mode-{}",
                            host.id,
                            host_mode_label(mode)
                        )))
                        .cursor_pointer()
                        .px(px(8.0))
                        .py(px(2.0))
                        .rounded_sm()
                        .bg(if is_active {
                            p.host_mode_color(mode)
                        } else {
                            p.deep_rail
                        })
                        .border_1()
                        .border_color(p.hairline_border)
                        .text_size(px(10.5))
                        .text_color(if is_active {
                            p.void_canvas
                        } else {
                            p.muted_text
                        })
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.bridge.send(BridgeCommand::SetHostMode {
                                host_id: host_id.clone(),
                                mode,
                            });
                            cx.notify();
                        }))
                        .child(host_mode_label(mode)),
                );
            }

            hosts_row = hosts_row.child(
                div()
                    .flex_1()
                    .p_2()
                    .rounded_md()
                    .bg(p.raised_surface)
                    .border_1()
                    .border_color(p.hairline_border)
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(p.host_teal)
                                    .child(format!("{} ({})", host.id, host.hostname)),
                            )
                            .child(mode_btns),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(p.muted_text)
                            .child(format!(
                                "CPU {}% / cap {}% · RAM {:.1}/{:.0}GB · slots {}/{}",
                                host.cpu_pct,
                                host.cap_pct,
                                host.ram_used_gb,
                                host.ram_total_gb,
                                host.active_slots,
                                host.max_slots
                            )),
                    ),
            );
        }

        // Scrollable overlay body
        let mut content = div()
            .id("fleet-overlay-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .p_3();

        // NEEDS YOU strip
        if !urgent.is_empty() {
            let mut strip = div()
                .p_2()
                .rounded_md()
                .bg(p.raised_surface)
                .border_1()
                .border_color(p.attention_coral)
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .text_size(px(10.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.attention_coral)
                        .child(format!("NEEDS YOU ({})", urgent.len())),
                );

            for s in urgent {
                let jump_id = s.id.clone();
                let mut row = div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.5))
                            .text_color(p.primary_text)
                            .child(format!(
                                "[{}] {} @{} — {}",
                                state_short_tag(s.state),
                                s.title,
                                s.host_id,
                                s.checkpoint
                            )),
                    );

                let mut btns = div().flex().items_center().gap_1().flex_shrink_0();
                if let Some(ref prompt) = s.prompt
                    && let Some(primary) = prompt.actions.first()
                {
                    let approve_sid = s.id.clone();
                    let approve_aid = primary.id.clone();
                    btns = btns.child(
                        div()
                            .id(SharedString::from(format!("urgent-approve-{}", s.id)))
                            .cursor_pointer()
                            .px_2()
                            .py(px(2.0))
                            .rounded_sm()
                            .bg(p.attention_coral)
                            .text_size(px(10.5))
                            .text_color(rgb_white())
                            .on_click(cx.listener(move |view, _, _, cx| {
                                view.bridge.send(BridgeCommand::ResolvePrompt {
                                    session_id: approve_sid.clone(),
                                    action_id: approve_aid.clone(),
                                    custom_reply: None,
                                });
                                cx.notify();
                            }))
                            .child(primary.label.clone()),
                    );
                }
                btns = btns.child(
                    div()
                        .id(SharedString::from(format!("urgent-jump-{}", s.id)))
                        .cursor_pointer()
                        .px_2()
                        .py(px(2.0))
                        .rounded_sm()
                        .bg(p.deep_rail)
                        .border_1()
                        .border_color(p.hairline_border)
                        .text_size(px(10.5))
                        .text_color(p.primary_text)
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.fleet_overlay_open = false;
                            view.attach_session_in_pane(
                                view.focused_pane,
                                jump_id.clone(),
                                window,
                                cx,
                            );
                        }))
                        .child("attach"),
                );

                row = row.child(btns);
                strip = strip.child(row);
            }
            content = content.child(strip);
        }

        content = content.child(hosts_row);

        // Live session rows
        let mut sessions_box = div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_size(px(10.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.muted_text)
                    .child(format!("LIVE SESSIONS ({})", live.len())),
            );

        for s in live {
            sessions_box = sessions_box.child(self.render_fleet_session_row(&s, cx));
        }
        content = content.child(sessions_box);

        // Collapsible Dormant Shelf
        let arrow = if self.dormant_fleet_expanded {
            "▾"
        } else {
            "▸"
        };
        let mut dormant_box = div().flex().flex_col().gap_1().child(
            div()
                .id("fleet-dormant-toggle")
                .cursor_pointer()
                .text_size(px(10.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.muted_text)
                .on_click(cx.listener(|view, _, _, cx| {
                    view.dormant_fleet_expanded = !view.dormant_fleet_expanded;
                    cx.notify();
                }))
                .child(format!("{arrow} DORMANT SHELF ({} · 0MB RAM)", dormant.len())),
        );

        if self.dormant_fleet_expanded {
            for s in dormant {
                let wake_sid = s.id.clone();
                let rebase_sid = s.id.clone();
                let mut wake_btns = div().flex().items_center().gap_1().flex_shrink_0();
                if s.git_behind_main > 0 {
                    wake_btns = wake_btns.child(
                        div()
                            .id(SharedString::from(format!("fleet-wake-rebase-{}", s.id)))
                            .cursor_pointer()
                            .px_2()
                            .py(px(2.0))
                            .rounded_sm()
                            .bg(p.accent_blue)
                            .text_size(px(10.5))
                            .text_color(rgb_white())
                            .on_click(cx.listener(move |view, _, window, cx| {
                                view.fleet_overlay_open = false;
                                view.wake_and_attach_session_in_pane(
                                    view.focused_pane,
                                    rebase_sid.clone(),
                                    true,
                                    window,
                                    cx,
                                );
                            }))
                            .child("wake+rebase"),
                    );
                }
                wake_btns = wake_btns.child(
                    div()
                        .id(SharedString::from(format!("fleet-wake-{}", s.id)))
                        .cursor_pointer()
                        .px_2()
                        .py(px(2.0))
                        .rounded_sm()
                        .bg(p.deep_rail)
                        .border_1()
                        .border_color(p.hairline_border)
                        .text_size(px(10.5))
                        .text_color(p.primary_text)
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.fleet_overlay_open = false;
                            view.attach_session_in_pane(
                                view.focused_pane,
                                wake_sid.clone(),
                                window,
                                cx,
                            );
                        }))
                        .child("wake"),
                );

                dormant_box = dormant_box.child(
                    div()
                        .px_2()
                        .py(px(5.0))
                        .rounded_sm()
                        .bg(p.raised_surface)
                        .border_1()
                        .border_color(p.hairline_border)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .child(
                            div()
                                .truncate()
                                .text_size(px(11.5))
                                .text_color(p.muted_text)
                                .child(format!("{} @{} · {}", s.title, s.host_id, s.checkpoint)),
                        )
                        .child(wake_btns),
                );
            }
        }
        content = content.child(dormant_box);

        let modal = div()
            .w(px(860.0))
            .max_h(px(620.0))
            .bg(p.deep_rail)
            .border_1()
            .border_color(p.hairline_border)
            .rounded_md()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .child(
                div()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(p.hairline_border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.primary_text)
                            .child("MULTI-PC FLEET & HOST CONTROL"),
                    )
                    .child(
                        div()
                            .id("fleet-close-btn")
                            .cursor_pointer()
                            .px_2()
                            .py(px(2.0))
                            .rounded_sm()
                            .border_1()
                            .border_color(p.hairline_border)
                            .text_size(px(11.0))
                            .text_color(p.muted_text)
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.fleet_overlay_open = false;
                                cx.notify();
                            }))
                            .child("Esc · Close"),
                    ),
            )
            .child(content);

        div()
            .absolute()
            .inset_0()
            .bg(p.overlay_backdrop)
            .flex()
            .items_center()
            .justify_center()
            .p_4()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, _, _, cx| {
                    view.fleet_overlay_open = false;
                    cx.notify();
                }),
            )
            .child(modal)
    }

    fn render_fleet_session_row(&self, s: &SessionSummary, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let target_host = self
            .hosts
            .iter()
            .find(|h| h.id != s.host_id)
            .cloned();

        let move_locked = target_host.as_ref().is_some_and(|th| {
            th.mode == HostMode::Off
                || s.pinned_host
                    .as_deref()
                    .is_some_and(|pinned| pinned != th.id)
        });

        let attach_sid = s.id.clone();
        let hib_sid = s.id.clone();

        let mut actions = div().flex().items_center().gap_1().flex_shrink_0();

        actions = actions.child(
            div()
                .id(SharedString::from(format!("fleet-attach-{}", s.id)))
                .cursor_pointer()
                .px_2()
                .py(px(2.0))
                .rounded_sm()
                .bg(p.accent_blue)
                .text_size(px(10.5))
                .text_color(rgb_white())
                .on_click(cx.listener(move |view, _, window, cx| {
                    view.fleet_overlay_open = false;
                    view.attach_session_in_pane(view.focused_pane, attach_sid.clone(), window, cx);
                }))
                .child("attach"),
        );

        if let Some(ref prompt) = s.prompt
            && let Some(primary) = prompt.actions.first()
        {
            let approve_sid = s.id.clone();
            let approve_aid = primary.id.clone();
            actions = actions.child(
                div()
                    .id(SharedString::from(format!("fleet-approve-{}", s.id)))
                    .cursor_pointer()
                    .px_2()
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(p.attention_coral)
                    .text_size(px(10.5))
                    .text_color(rgb_white())
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.bridge.send(BridgeCommand::ResolvePrompt {
                            session_id: approve_sid.clone(),
                            action_id: approve_aid.clone(),
                            custom_reply: None,
                        });
                        cx.notify();
                    }))
                    .child("approve"),
            );
        }

        if let Some(th) = target_host {
            let move_sid = s.id.clone();
            let move_target = th.id.clone();
            let label = if move_locked {
                format!("[LOCK] move -> {}", th.id)
            } else {
                format!("move -> {}", th.id)
            };
            actions = actions.child(
                div()
                    .id(SharedString::from(format!("fleet-move-{}", s.id)))
                    .cursor_pointer()
                    .px_2()
                    .py(px(2.0))
                    .rounded_sm()
                    .bg(p.deep_rail)
                    .border_1()
                    .border_color(if move_locked {
                        p.error_red
                    } else {
                        p.hairline_border
                    })
                    .text_size(px(10.5))
                    .text_color(if move_locked {
                        p.error_red
                    } else {
                        p.primary_text
                    })
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.bridge.send(BridgeCommand::MoveSessionHost {
                            session_id: move_sid.clone(),
                            target_host_id: move_target.clone(),
                        });
                        cx.notify();
                    }))
                    .child(label),
            );
        }

        actions = actions.child(
            div()
                .id(SharedString::from(format!("fleet-hib-{}", s.id)))
                .cursor_pointer()
                .px_2()
                .py(px(2.0))
                .rounded_sm()
                .bg(p.deep_rail)
                .border_1()
                .border_color(p.hairline_border)
                .text_size(px(10.5))
                .text_color(p.muted_text)
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.hibernate_session(hib_sid.clone(), cx);
                }))
                .child("hibernate"),
        );

        div()
            .px_2()
            .py(px(5.0))
            .rounded_sm()
            .bg(p.raised_surface)
            .border_1()
            .border_color(p.hairline_border)
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .w(px(7.0))
                            .h(px(7.0))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(p.state_color(s.state)),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.5))
                            .text_color(p.primary_text)
                            .child(format!(
                                "{} @{} · {} · {}MB",
                                s.title, s.host_id, s.phase, s.ram_mb
                            )),
                    ),
            )
            .child(actions)
    }

    fn render_omnibox_overlay(&self, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let matches = self.omnibox_matches();

        let mut rows = div().flex().flex_col().py_1();
        for (idx, s) in matches.iter().enumerate() {
            let is_sel = idx == self.omnibox_selected;
            let sid = s.id.clone();
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("omni-row-{idx}")))
                    .cursor_pointer()
                    .px_3()
                    .py(px(6.0))
                    .bg(if is_sel {
                        p.active_row
                    } else {
                        p.raised_surface
                    })
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.omnibox_open = false;
                        view.omnibox_query.clear();
                        view.attach_session_in_pane(view.focused_pane, sid.clone(), window, cx);
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .min_w_0()
                            .child(
                                div()
                                    .w(px(7.0))
                                    .h(px(7.0))
                                    .rounded_full()
                                    .flex_shrink_0()
                                    .bg(p.state_color(s.state)),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(12.0))
                                    .text_color(p.primary_text)
                                    .child(s.title.clone()),
                            ),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(10.5))
                            .text_color(p.muted_text)
                            .child(format!("@{} · {}", s.host_id, state_short_tag(s.state))),
                    ),
            );
        }

        let spawn_idx = matches.len();
        let spawn_selected = self.omnibox_selected >= spawn_idx;
        let spawn_query = self.omnibox_query.trim().to_string();
        let spawn_label = if spawn_query.is_empty() {
            "+ Spawn new live shell session (Enter)".to_string()
        } else {
            format!("+ Spawn new session \"{spawn_query}\" (Enter)")
        };

        rows = rows.child(
            div()
                .id("omni-spawn-row")
                .cursor_pointer()
                .px_3()
                .py(px(6.0))
                .bg(if spawn_selected {
                    p.active_row
                } else {
                    p.raised_surface
                })
                .border_t_1()
                .border_color(p.hairline_border)
                .text_size(px(12.0))
                .text_color(p.accent_blue)
                .on_click(cx.listener(move |view, _, window, cx| {
                    view.omnibox_open = false;
                    let q = view.omnibox_query.trim().to_string();
                    view.omnibox_query.clear();
                    view.spawn_new_session_into_pane(
                        view.focused_pane,
                        (!q.is_empty()).then_some(q),
                        window,
                        cx,
                    );
                }))
                .child(spawn_label),
        );

        let query_display = if self.omnibox_query.is_empty() {
            "Type to jump across sessions or press Enter to spawn...".to_string()
        } else {
            format!("{}_", self.omnibox_query)
        };

        let palette_box = div()
            .w(px(580.0))
            .mt(px(64.0))
            .bg(p.raised_surface)
            .border_1()
            .border_color(p.accent_blue)
            .rounded_md()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .child(
                div()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(p.hairline_border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(if self.omnibox_query.is_empty() {
                                p.muted_text
                            } else {
                                p.primary_text
                            })
                            .child(query_display),
                    )
                    .child(
                        div()
                            .text_size(px(10.5))
                            .text_color(p.muted_text)
                            .child("Esc"),
                    ),
            )
            .child(rows);

        div()
            .absolute()
            .inset_0()
            .bg(p.overlay_backdrop)
            .flex()
            .items_start()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, _, _, cx| {
                    view.omnibox_open = false;
                    cx.notify();
                }),
            )
            .child(palette_box)
    }

    fn render_toast(&self, toast: &ToastNotice, cx: &mut Context<Self>) -> Div {
        let p = self.palette;
        let border = if toast.is_error {
            p.error_red
        } else {
            p.accent_blue
        };
        div()
            .absolute()
            .bottom(px(STATUSLINE_HEIGHT_PX + 10.0))
            .right(px(12.0))
            .child(
                div()
                    .id("iron-toast")
                    .cursor_pointer()
                    .px_3()
                    .py(px(6.0))
                    .rounded_md()
                    .bg(p.raised_surface)
                    .border_1()
                    .border_color(border)
                    .text_size(px(11.5))
                    .text_color(if toast.is_error {
                        p.error_red
                    } else {
                        p.primary_text
                    })
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.toast = None;
                        cx.notify();
                    }))
                    .child(toast.message.clone()),
            )
    }
}

impl Render for IronTermView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.palette;

        // Keep PTY dimensions synced whenever layout toggles or window bounds settle.
        self.sync_pty_dimensions(window, cx);

        let mut workspace = div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .flex()
            .flex_row()
            .overflow_hidden()
            .child(self.render_pane(0, cx));

        if self.split_open {
            workspace = workspace
                .child(div().w(px(1.0)).h_full().bg(p.hairline_border))
                .child(self.render_pane(1, cx));
        }

        let mut main_row = div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_row()
            .overflow_hidden();

        if self.rail_open {
            main_row = main_row.child(self.render_whisper_rail(cx));
        }
        main_row = main_row.child(workspace);

        let mut root = div()
            .relative()
            .size_full()
            .bg(p.void_canvas)
            .text_color(p.primary_text)
            .font_family(self.mono_font_family.clone())
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .child(main_row)
            .child(self.render_statusline(cx));

        if self.fleet_overlay_open {
            root = root.child(self.render_fleet_overlay(cx));
        }

        if self.omnibox_open {
            root = root.child(self.render_omnibox_overlay(cx));
        }

        if let Some(ref toast) = self.toast {
            root = root.child(self.render_toast(toast, cx));
        }

        root
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyAction {
    ToggleRail,
    ToggleFleetOverlay,
    CloseFleetOverlay,
    ToggleOmnibox,
    OmniboxInput,
    ToggleSplit,
    FocusPane(usize),
    GhostAction(usize),
    ForwardEof,
    PasteClipboard,
    ForwardPty,
    Ignore,
}

#[allow(clippy::too_many_arguments)]
fn classify_key_action(
    key: &str,
    ctrl: bool,
    alt: bool,
    shift: bool,
    platform: bool,
    omnibox_open: bool,
    fleet_overlay_open: bool,
    split_open: bool,
    has_ghost_bar: bool,
    is_hibernated: bool,
) -> KeyAction {
    let key_lower = key.to_ascii_lowercase();
    let ctrl_or_cmd = (ctrl || platform) && !alt;

    // 1. Gate active modal overlays FIRST so background PTY / Ghost / EOF shortcuts can never leak.
    if omnibox_open {
        if ctrl_or_cmd && !shift {
            return match key_lower.as_str() {
                "k" => KeyAction::ToggleOmnibox,
                "b" => KeyAction::ToggleFleetOverlay,
                _ => KeyAction::Ignore,
            };
        }
        return KeyAction::OmniboxInput;
    }

    if fleet_overlay_open {
        if key_lower == "escape" {
            return KeyAction::CloseFleetOverlay;
        }
        if ctrl_or_cmd && !shift {
            return match key_lower.as_str() {
                "b" => KeyAction::ToggleFleetOverlay,
                "k" => KeyAction::ToggleOmnibox,
                _ => KeyAction::Ignore,
            };
        }
        return KeyAction::Ignore;
    }

    // 2. Global non-modal Alacritty-Blade shortcuts.
    if ctrl_or_cmd && !shift {
        match key_lower.as_str() {
            "\\" => return KeyAction::ToggleRail,
            "b" => return KeyAction::ToggleFleetOverlay,
            "k" => return KeyAction::ToggleOmnibox,
            "d" => return KeyAction::ToggleSplit,
            "1" if has_ghost_bar => return KeyAction::GhostAction(0),
            "2" if has_ghost_bar => return KeyAction::GhostAction(1),
            "3" if has_ghost_bar => return KeyAction::GhostAction(2),
            _ => {}
        }
    }

    // 3. Alt+1/2/3 only intercept when Ghost Action Bar is visible; Alt+Left/Right switch panes.
    if alt && !ctrl && !platform && !shift {
        match key_lower.as_str() {
            "1" if has_ghost_bar => return KeyAction::GhostAction(0),
            "2" if has_ghost_bar => return KeyAction::GhostAction(1),
            "3" if has_ghost_bar => return KeyAction::GhostAction(2),
            "left" if split_open => return KeyAction::FocusPane(0),
            "right" if split_open => return KeyAction::FocusPane(1),
            _ => {}
        }
    }

    // 4. Terminal Ctrl+Shift chords (only when no modal is open).
    if ctrl && shift && !alt && !platform {
        match key_lower.as_str() {
            "d" => return KeyAction::ForwardEof,
            "v" => return KeyAction::PasteClipboard,
            "c" => return KeyAction::Ignore,
            _ => {}
        }
    }

    // 5. Direct 1/2 wake keys on a Hibernated pane (no live PTY attached).
    if !ctrl && !alt && !shift && !platform && is_hibernated {
        match key_lower.as_str() {
            "1" => return KeyAction::GhostAction(0),
            "2" => return KeyAction::GhostAction(1),
            _ => {}
        }
    }

    KeyAction::ForwardPty
}

fn session_has_ghost_bar(s: &SessionSummary) -> bool {
    s.prompt.is_some() || s.state == AgentState::Hibernated
}

const PORTABLE_MONO_FONTS: &[&str] = &[
    "JetBrains Mono",
    "JetBrainsMono Nerd Font",
    "JetBrainsMonoNL Nerd Font",
    "JetBrainsMono Nerd Font Mono",
    "Fira Code",
    "FiraCode Nerd Font",
    "Cascadia Code",
    "Hack",
    "IBM Plex Mono",
    "Source Code Pro",
    "Ubuntu Mono",
    "Ubuntu Sans Mono",
    "Noto Sans Mono",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Adwaita Mono",
    "FreeMono",
    "Courier New",
];

fn find_font_match(available_fonts: &[String], candidate: &str) -> Option<String> {
    if let Some(exact) = available_fonts.iter().find(|f| f.as_str() == candidate) {
        return Some(exact.clone());
    }
    available_fonts
        .iter()
        .find(|f| f.eq_ignore_ascii_case(candidate))
        .cloned()
}

/// Resolves a monospace font family from `IRON_TERM_FONT` and available system fonts.
pub fn resolve_monospace_font(
    env_override: Option<&str>,
    available_fonts: &[String],
) -> SharedString {
    if let Some(requested) = env_override.map(str::trim).filter(|s| !s.is_empty()) {
        if available_fonts.is_empty() {
            return SharedString::from(requested.to_string());
        }
        if let Some(matched) = find_font_match(available_fonts, requested) {
            return SharedString::from(matched);
        }
    }

    for candidate in PORTABLE_MONO_FONTS {
        if let Some(matched) = find_font_match(available_fonts, candidate) {
            return SharedString::from(matched);
        }
    }

    if let Some(any_mono) = available_fonts.iter().find(|name| {
        let lower = name.to_ascii_lowercase();
        !name.starts_with('.') && lower.contains("mono") && !lower.contains("emoji")
    }) {
        return SharedString::from(any_mono.clone());
    }

    SharedString::from("DejaVu Sans Mono")
}

fn short_host(host_id: &str) -> String {
    let trimmed = host_id.trim();
    match trimmed {
        "desktop" => "desk".to_string(),
        "laptop" => "lap".to_string(),
        other => {
            let base = other
                .split('.')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(other);
            if base.chars().count() <= 10 {
                base.to_string()
            } else {
                let prefix: String = base.chars().take(9).collect();
                format!("{prefix}…")
            }
        }
    }
}

fn rgb_white() -> gpui::Rgba {
    gpui::rgb(0xffffff)
}

/// UTF-8-safe cursor splitter for rendering the monospace terminal cursor cell.
pub fn split_line_at_cursor(text: &str, cursor_col: u16) -> (String, String, String) {
    let target = usize::from(cursor_col);
    let chars: Vec<char> = text.chars().collect();

    if target < chars.len() {
        let before: String = chars[..target].iter().collect();
        let cur = chars[target].to_string();
        let after: String = chars[target + 1..].iter().collect();
        (before, cur, after)
    } else {
        let mut before = text.to_string();
        let pad = target.saturating_sub(chars.len());
        for _ in 0..pad {
            before.push(' ');
        }
        (before, " ".to_string(), String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_ascii_and_utf8_lines_at_cursor_without_panicking() {
        assert_eq!(
            split_line_at_cursor("hello", 1),
            ("h".into(), "e".into(), "llo".into())
        );
        assert_eq!(
            split_line_at_cursor("café!", 3),
            ("caf".into(), "é".into(), "!".into())
        );
        assert_eq!(
            split_line_at_cursor("hi", 4),
            ("hi  ".into(), " ".into(), "".into())
        );
    }

    #[test]
    fn modals_gate_background_shortcuts_and_eof() {
        // Behind Fleet Overlay: Ctrl+Shift+D, Ctrl+1, Alt+1, Ctrl+D must NEVER leak.
        assert_eq!(
            classify_key_action("d", true, false, true, false, false, true, false, true, false),
            KeyAction::Ignore
        );
        assert_eq!(
            classify_key_action("1", true, false, false, false, false, true, false, true, false),
            KeyAction::Ignore
        );
        assert_eq!(
            classify_key_action("1", false, true, false, false, false, true, false, true, false),
            KeyAction::Ignore
        );
        assert_eq!(
            classify_key_action("escape", false, false, false, false, false, true, false, true, false),
            KeyAction::CloseFleetOverlay
        );
        assert_eq!(
            classify_key_action("b", true, false, false, false, false, true, false, true, false),
            KeyAction::ToggleFleetOverlay
        );

        // Behind Omnibox: Ctrl+Shift+D and Alt+1 route to omnibox/ignore, never EOF or GhostAction.
        assert_eq!(
            classify_key_action("d", true, false, true, false, true, false, false, true, false),
            KeyAction::OmniboxInput
        );
        assert_eq!(
            classify_key_action("1", true, false, false, false, true, false, false, true, false),
            KeyAction::Ignore
        );
        assert_eq!(
            classify_key_action("k", true, false, false, false, true, false, false, true, false),
            KeyAction::ToggleOmnibox
        );
    }

    #[test]
    fn ghost_hotkeys_only_intercept_when_ghost_bar_is_visible() {
        // No ghost bar -> Alt+1 and Ctrl+1 fall through to PTY.
        assert_eq!(
            classify_key_action("1", false, true, false, false, false, false, false, false, false),
            KeyAction::ForwardPty
        );
        assert_eq!(
            classify_key_action("1", true, false, false, false, false, false, false, false, false),
            KeyAction::ForwardPty
        );

        // Ghost bar visible -> Alt+1 and Ctrl+1 resolve ghost action #0.
        assert_eq!(
            classify_key_action("1", false, true, false, false, false, false, false, true, false),
            KeyAction::GhostAction(0)
        );
        assert_eq!(
            classify_key_action("2", true, false, false, false, false, false, false, true, false),
            KeyAction::GhostAction(1)
        );

        // Ctrl+Shift+V pastes, Ctrl+Shift+C does not emit SIGINT, Ctrl+Shift+D sends EOF.
        assert_eq!(
            classify_key_action("v", true, false, true, false, false, false, false, false, false),
            KeyAction::PasteClipboard
        );
        assert_eq!(
            classify_key_action("c", true, false, true, false, false, false, false, false, false),
            KeyAction::Ignore
        );
        assert_eq!(
            classify_key_action("d", true, false, true, false, false, false, false, false, false),
            KeyAction::ForwardEof
        );
    }

    #[test]
    fn short_host_abbreviates_and_truncates_utf8_safely() {
        assert_eq!(short_host("desktop"), "desk");
        assert_eq!(short_host("laptop"), "lap");
        assert_eq!(short_host("fedora"), "fedora");
        assert_eq!(short_host("devbox.internal.corp"), "devbox");
        assert_eq!(short_host("workstat10"), "workstat10");
        assert_eq!(short_host("very-long-workstation-name"), "very-long…");
        assert_eq!(short_host("café-bistro-node"), "café-bist…");
        assert_eq!(short_host("very-long-workstation-name").chars().count(), 10);
    }

    #[test]
    fn resolves_monospace_font_with_override_and_portable_fallbacks() {
        let gnome_fonts = vec![
            ".ZedMono".to_string(),
            "Cantarell".to_string(),
            "Adwaita Mono".to_string(),
        ];
        assert_eq!(
            resolve_monospace_font(None, &gnome_fonts).as_ref(),
            "Adwaita Mono"
        );
        assert_eq!(
            resolve_monospace_font(Some("adwaita mono"), &gnome_fonts).as_ref(),
            "Adwaita Mono"
        );
        assert_eq!(
            resolve_monospace_font(Some("NonExistent Font"), &gnome_fonts).as_ref(),
            "Adwaita Mono"
        );

        let minimal_fonts = vec!["DejaVu Sans".to_string(), "Liberation Mono".to_string()];
        assert_eq!(
            resolve_monospace_font(None, &minimal_fonts).as_ref(),
            "Liberation Mono"
        );

        let custom_mono_only = vec![
            ".ZedMono".to_string(),
            "Noto Color Emoji".to_string(),
            "Custom Mono Display".to_string(),
        ];
        assert_eq!(
            resolve_monospace_font(None, &custom_mono_only).as_ref(),
            "Custom Mono Display"
        );

        assert_eq!(
            resolve_monospace_font(Some("My Custom Mono"), &[]).as_ref(),
            "My Custom Mono"
        );
        assert_eq!(
            resolve_monospace_font(Some("  "), &[]).as_ref(),
            "DejaVu Sans Mono"
        );
    }
}
