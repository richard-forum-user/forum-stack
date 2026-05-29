#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{TcpListener, SocketAddr};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// Workerd config template — `{PORT}`, `{DATA_DIR}` and `{AIRLOCK_DIR}`
/// are substituted at boot.
const WORKERD_CAPNP_TEMPLATE: &str = include_str!("../workerd-config.capnp");

struct WorkerdHandle(Mutex<Option<CommandChild>>);

#[tauri::command]
fn pod_status(state: tauri::State<'_, WorkerdHandle>) -> serde_json::Value {
    let running = state.0.lock().unwrap().is_some();
    serde_json::json!({ "running": running })
}

/// Background updater check. Runs ~5 seconds after launch so it does
/// not race the workerd boot path; on a hit it shows the built-in
/// updater dialog (configured via `tauri.conf.json -> plugins.updater
/// .dialog = true`).
async fn check_for_updates(app: tauri::AppHandle) {
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                log::info!(
                    "update available: {} (current {})",
                    update.version,
                    update.current_version
                );
                if let Err(e) = update
                    .download_and_install(
                        |chunk_length, content_length| {
                            log::info!(
                                "update download: {}/{:?}",
                                chunk_length,
                                content_length
                            );
                        },
                        || log::info!("update download finished"),
                    )
                    .await
                {
                    log::error!("update install failed: {e:?}");
                } else {
                    log::info!("update installed; relaunching");
                    app.restart();
                }
            }
            Ok(None) => log::info!("no updates available"),
            Err(e) => log::warn!("update check failed: {e:?}"),
        },
        Err(e) => log::warn!("updater plugin not available: {e:?}"),
    }
}

fn find_free_port() -> Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    Ok(listener.local_addr()?.port())
}

fn write_runtime_config(
    app_data: &PathBuf,
    airlock_dir: &PathBuf,
    port: u16,
) -> Result<PathBuf> {
    let pod_data_dir = app_data.join("pod-data");
    fs::create_dir_all(&pod_data_dir).context("create pod-data dir")?;

    let rendered = WORKERD_CAPNP_TEMPLATE
        .replace("{PORT}", &port.to_string())
        .replace(
            "{DATA_DIR}",
            pod_data_dir.to_str().ok_or_else(|| anyhow!("non-utf8 data path"))?,
        )
        .replace(
            "{AIRLOCK_DIR}",
            airlock_dir.to_str().ok_or_else(|| anyhow!("non-utf8 airlock path"))?,
        );

    let config_path = app_data.join("workerd-config.capnp");
    fs::write(&config_path, rendered).context("write workerd config")?;
    Ok(config_path)
}

fn spawn_workerd(
    app: &tauri::AppHandle,
    config_path: &PathBuf,
) -> Result<(CommandChild, u16)> {
    let port = {
        let stem = config_path.file_name().unwrap().to_string_lossy().to_string();
        log::info!("loading workerd config from {}", stem);
        // The port is embedded in the file; we trust the caller. Returning
        // it lets the UI know where to point.
        let body = fs::read_to_string(config_path)?;
        body.lines()
            .find_map(|l| {
                let trimmed = l.trim();
                if let Some(idx) = trimmed.find("127.0.0.1:") {
                    let tail = &trimmed[idx + "127.0.0.1:".len()..];
                    let port_str: String =
                        tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                    port_str.parse::<u16>().ok()
                } else {
                    None
                }
            })
            .ok_or_else(|| anyhow!("could not parse port from config"))?
    };

    let cmd = app
        .shell()
        .sidecar("workerd")
        .context("workerd sidecar missing — did `scripts/fetch-workerd.sh` run?")?
        .args([
            "serve",
            config_path.to_str().unwrap(),
            "--verbose",
        ]);

    let (mut rx, child) = cmd.spawn().context("spawn workerd")?;

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("workerd: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("workerd[err]: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("workerd terminated: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok((child, port))
}

fn boot(app: &tauri::AppHandle) -> Result<(CommandChild, u16)> {
    let app_data = app
        .path()
        .app_data_dir()
        .context("resolve app_data_dir")?;
    fs::create_dir_all(&app_data).context("create app_data_dir")?;

    let resource_dir = app.path().resource_dir().context("resource_dir")?;
    let airlock_dir = resource_dir.join("airlock");
    if !airlock_dir.exists() {
        return Err(anyhow!(
            "bundled airlock worker missing at {}",
            airlock_dir.display()
        ));
    }

    let port = find_free_port()?;
    let config_path = write_runtime_config(&app_data, &airlock_dir, port)?;
    let (child, port) = spawn_workerd(app, &config_path)?;
    Ok((child, port))
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let handle = WorkerdHandle(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(handle)
        .invoke_handler(tauri::generate_handler![pod_status])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let updater_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                check_for_updates(updater_handle).await;
            });
            match boot(&app_handle) {
                Ok((child, port)) => {
                    {
                        let state = app_handle.state::<WorkerdHandle>();
                        *state.0.lock().unwrap() = Some(child);
                    }
                    let url = format!("http://127.0.0.1:{}", port);
                    log::info!("pod ready at {}", url);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval(&format!(
                            "if (window.location.origin !== '{u}') {{ window.location.replace('{u}'); }}",
                            u = url
                        ));
                    }
                }
                Err(e) => {
                    log::error!("failed to start workerd sidecar: {e:?}");
                    let _ = tauri_plugin_dialog::DialogExt::dialog(&app_handle)
                        .message(format!(
                            "Forum Pod could not start its local server:\n\n{e}\n\nThe app will close."
                        ))
                        .title("Forum Pod")
                        .blocking_show();
                    app_handle.exit(1);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            let stop_workerd = || {
                let state = app_handle.state::<WorkerdHandle>();
                let mut guard = state.0.lock().unwrap();
                if let Some(child) = guard.take() {
                    let _ = child.kill();
                }
            };
            if matches!(event, RunEvent::ExitRequested { .. }) {
                stop_workerd();
            }
            if let RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } = event
            {
                stop_workerd();
            }
        });
}

// Keep the unused-import warning quiet on Windows/macOS where `Child`
// isn't otherwise referenced.
#[allow(dead_code)]
fn _keep_child_alive(_c: Child) {}
