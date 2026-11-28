mod app;
mod bootstrap;
mod cli;
mod client;
mod theme;
mod vt_input;

use anyhow::Result;
use clap::Parser;
use gpui::{
    App, AppContext, Application, Bounds, SharedString, TitlebarOptions, WindowBounds,
    WindowOptions, px, size,
};

use crate::app::IronTermView;
use crate::bootstrap::ensure_daemon_running;
use crate::cli::CliArgs;
use crate::client::{DaemonBridge, StartupIntent};

fn main() -> Result<()> {
    let args = CliArgs::parse();
    let socket_path = args.socket_path();

    // Auto-bootstrap iron-agentd if not already listening on the Unix socket.
    ensure_daemon_running(&socket_path)?;

    let spawn_meta = args.derive_spawn_metadata();
    let startup = StartupIntent {
        force_spawn: args.force_spawn_new_session(),
        spawn: spawn_meta.clone(),
        initial_cols: 120,
        initial_rows: 36,
    };

    let (bridge, event_rx) = DaemonBridge::spawn(socket_path, startup);
    let window_title = args.initial_window_title();
    let start_light = args.light;

    let mut bridge_slot = Some(bridge);
    let mut rx_slot = Some(event_rx);

    Application::new().run(move |cx: &mut App| {
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(1240.0), px(780.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(SharedString::from(window_title.clone())),
                appears_transparent: false,
                traffic_light_position: None,
            }),
            app_id: Some("iron-term".to_string()),
            focus: true,
            ..Default::default()
        };

        let bridge = bridge_slot.take().expect("bridge initialized once");
        let event_rx = rx_slot.take().expect("event_rx initialized once");
        let default_spawn = spawn_meta.clone();

        cx.open_window(options, move |window, cx| {
            cx.new(|cx| {
                IronTermView::new(bridge, event_rx, default_spawn, start_light, window, cx)
            })
        })
        .expect("open iron-term GPUI window");

        cx.activate(true);
    });

    Ok(())
}
