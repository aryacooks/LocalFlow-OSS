use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub url: String,
    pub size_mb: u32,
    pub description: String,
}

/// Platform-specific name of the llama.cpp CLI binary.
fn llama_cli_filename() -> &'static str {
    if cfg!(windows) {
        "llama-cli.exe"
    } else {
        "llama-cli"
    }
}

/// Legacy name used by older llama.cpp releases (renamed to llama-cli on extract).
fn llama_legacy_filename() -> &'static str {
    if cfg!(windows) {
        "main.exe"
    } else {
        "main"
    }
}

/// Platform-specific precompiled llama.cpp release asset URL.
fn llama_download_url() -> &'static str {
    #[cfg(windows)]
    {
        "https://github.com/ggml-org/llama.cpp/releases/download/b3040/llama-b3040-bin-win-avx2-x64.zip"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "https://github.com/ggml-org/llama.cpp/releases/download/b3040/llama-b3040-bin-macos-arm64.zip"
    }
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    {
        "https://github.com/ggml-org/llama.cpp/releases/download/b3040/llama-b3040-bin-macos-x64.zip"
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        ""
    }
}

/// On Unix, make the binary executable and clear macOS quarantine so it can run.
fn make_runnable(bin_dir: &std::path::Path, cli_path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(cli_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(cli_path, perms);
        }
        // Remove the com.apple.quarantine attribute that blocks downloaded binaries.
        let _ = Command::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(bin_dir)
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = (bin_dir, cli_path);
    }
}

pub fn available_llm_models() -> Vec<LlmModelInfo> {
    vec![
        LlmModelInfo {
            id: "llama-3.2-1b".into(),
            name: "Standard (Recommended)".into(),
            filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf".into(),
            url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf".into(),
            size_mb: 702,
            description: "Recommended. Good cleanup quality and works well on most computers.".into(),
        },
    ]
}

pub fn get_llm_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    path.push("bin");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn get_llm_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    path.push("llm_models");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn list_llm_models(app: AppHandle) -> Vec<serde_json::Value> {
    let models = available_llm_models();
    let models_dir = get_llm_models_dir(&app).unwrap_or_default();
    let active_filename = get_llm_setting(
        &app,
        "llm_active_model",
        "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    );

    models
        .iter()
        .map(|m| {
            let path = models_dir.join(&m.filename);
            let downloaded = path.exists();
            let size_on_disk = if downloaded {
                fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
            } else {
                0
            };
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "filename": m.filename,
                "url": m.url,
                "size_mb": m.size_mb,
                "description": m.description,
                "downloaded": downloaded,
                "size_on_disk": size_on_disk,
                "is_active": m.filename == active_filename,
            })
        })
        .collect()
}

#[tauri::command]
pub fn is_llama_cli_installed(app: AppHandle) -> bool {
    let bin_dir = match get_llm_bin_dir(&app) {
        Ok(d) => d,
        Err(_) => return false,
    };
    let cli_path = bin_dir.join(llama_cli_filename());
    if cli_path.exists() {
        return true;
    }
    // Automatically rename legacy `main` binary from older llama.cpp releases
    let main_exe = bin_dir.join(llama_legacy_filename());
    if main_exe.exists() {
        if fs::rename(&main_exe, &cli_path).is_ok() {
            make_runnable(&bin_dir, &cli_path);
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn download_llama_cli(app: AppHandle) -> Result<String, String> {
    let bin_dir = get_llm_bin_dir(&app)?;
    let cli_path = bin_dir.join(llama_cli_filename());

    if cli_path.exists() {
        return Ok("llama-cli already installed".into());
    }

    let url = llama_download_url();
    if url.is_empty() {
        return Err("No prebuilt llama.cpp binary available for this platform".into());
    }
    let dest_zip = bin_dir.join("llama-bin.zip");

    println!("Downloading llama.cpp precompiled binaries...");
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {}",
            response.status().as_u16()
        ));
    }

    let total_size = response
        .content_length()
        .ok_or_else(|| "Failed to get content length".to_string())?;

    let mut file =
        std::fs::File::create(&dest_zip).map_err(|e| format!("Failed to save zip file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = response.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| {
            let _ = fs::remove_file(&dest_zip);
            format!("Error while downloading: {}", e)
        })?;

        file.write_all(&chunk).map_err(|e| {
            let _ = fs::remove_file(&dest_zip);
            format!("Failed to write chunk: {}", e)
        })?;

        downloaded += chunk.len() as u64;
        let percent = (downloaded * 100 / total_size) as u32;

        if last_emit.elapsed().as_millis() > 100 || percent == 100 {
            app.emit(
                "download-progress",
                serde_json::json!({
                    "id": "llama-cli",
                    "progress": percent,
                }),
            )
            .ok();
            last_emit = std::time::Instant::now();
        }
    }

    file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&dest_zip);
        format!("Failed to sync zip file: {}", e)
    })?;
    drop(file);

    println!("Extracting llama.cpp zip using system tar...");

    // tar is native to Windows 10/11
    let status = Command::new("tar")
        .args([
            "-xf",
            dest_zip.to_str().unwrap(),
            "-C",
            bin_dir.to_str().unwrap(),
        ])
        .status()
        .map_err(|e| format!("Failed to run tar: {}", e))?;

    // Cleanup zip file
    let _ = fs::remove_file(&dest_zip);

    if !status.success() {
        return Err("Extraction failed".into());
    }

    // Release zips vary: newer ones ship `llama-cli`, older ones ship `main`, and
    // macOS builds nest everything under `build/bin/`. Search recursively for either
    // name and promote it to the expected top-level path.
    if !cli_path.exists() {
        let found = find_file_recursive(&bin_dir, llama_cli_filename())
            .or_else(|| find_file_recursive(&bin_dir, llama_legacy_filename()));
        if let Some(found) = found {
            let _ = fs::rename(&found, &cli_path);
        }
    }

    // macOS Metal builds need ggml-metal.metal beside the binary to use the GPU.
    // (The binary still runs on CPU without it, but we move it so GPU works too.)
    let metal_dest = bin_dir.join("ggml-metal.metal");
    if !metal_dest.exists() {
        if let Some(metal) = find_file_recursive(&bin_dir, "ggml-metal.metal") {
            let _ = fs::rename(&metal, &metal_dest);
        }
    }

    if cli_path.exists() {
        make_runnable(&bin_dir, &cli_path);
        Ok("llama-cli successfully installed".into())
    } else {
        Err(format!(
            "{} not found after extraction",
            llama_cli_filename()
        ))
    }
}

/// Recursively search `dir` for a file with the given name.
fn find_file_recursive(dir: &std::path::Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, name) {
                return Some(found);
            }
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            return Some(path);
        }
    }
    None
}

#[tauri::command]
pub async fn download_llm_model(app: AppHandle, model_id: String) -> Result<String, String> {
    let models = available_llm_models();
    let model = models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?
        .clone();

    let models_dir = get_llm_models_dir(&app)?;
    let dest_path = models_dir.join(&model.filename);

    if dest_path.exists() {
        return Ok(format!("Model {} already downloaded", model.name));
    }

    println!("Downloading model {} from {}...", model.name, model.url);

    let response = reqwest::get(&model.url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {}",
            response.status().as_u16()
        ));
    }

    let total_size = response
        .content_length()
        .ok_or_else(|| "Failed to get content length".to_string())?;

    let tmp_path = dest_path.with_extension("download");
    if tmp_path.exists() {
        let _ = fs::remove_file(&tmp_path);
    }

    let mut file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = response.bytes_stream();
    // Drop any stale cancel flag from a previous attempt before we start streaming.
    crate::download::clear_cancel(&model.id);

    while let Some(item) = stream.next().await {
        // Abort promptly if the user pressed Cancel for this download.
        if crate::download::cancel_requested(&model.id) {
            drop(file);
            let _ = fs::remove_file(&tmp_path);
            crate::download::clear_cancel(&model.id);
            return Err("Download cancelled".to_string());
        }

        let chunk = item.map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Error while downloading: {}", e)
        })?;

        file.write_all(&chunk).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Failed to write chunk: {}", e)
        })?;

        downloaded += chunk.len() as u64;
        let percent = (downloaded * 100 / total_size) as u32;

        if last_emit.elapsed().as_millis() > 100 || percent == 100 {
            app.emit(
                "download-progress",
                serde_json::json!({
                    "id": model.id,
                    "progress": percent,
                }),
            )
            .ok();
            last_emit = std::time::Instant::now();
        }
    }

    file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to sync file: {}", e)
    })?;
    drop(file);

    if let Err(e) = fs::rename(&tmp_path, &dest_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to save final model file: {}", e));
    }

    Ok(format!(
        "Downloaded {} ({} MB)",
        model.name,
        downloaded / 1_000_000
    ))
}

#[tauri::command]
pub fn delete_llm_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let models = available_llm_models();
    let model = models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let models_dir = get_llm_models_dir(&app)?;
    let dest_path = models_dir.join(&model.filename);

    if dest_path.exists() {
        fs::remove_file(&dest_path).map_err(|e| format!("Failed to delete model file: {}", e))?;
    }

    // If the deleted model was active, fall back to the recommended default.
    let active = get_llm_setting(
        &app,
        "llm_active_model",
        "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    );
    if active == model.filename {
        if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            let conn = db_state.0.lock().unwrap();
            let _ = conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                rusqlite::params!["llm_active_model", "Llama-3.2-1B-Instruct-Q4_K_M.gguf"],
            );
        }
    }

    Ok(())
}

pub fn run_inference(app: &AppHandle, prompt: &str) -> Result<String, String> {
    let bin_dir = get_llm_bin_dir(app)?;
    let cli_path = bin_dir.join(llama_cli_filename());

    if !cli_path.exists() {
        return Err(format!("{} is not installed", llama_cli_filename()));
    }

    // Get active model
    let models_dir = get_llm_models_dir(app)?;
    let active_model =
        get_llm_setting(app, "llm_active_model", "Llama-3.2-1B-Instruct-Q4_K_M.gguf");

    // No model selected (the user unselected it, keeping only the helper installed) —
    // there is nothing to run, so signal the caller to use basic cleanup instead.
    if active_model.trim().is_empty() {
        return Err("No cleanup model selected".to_string());
    }

    let model_path = models_dir.join(&active_model);

    if !model_path.exists() {
        return Err(format!("LLM model file not found at {:?}", model_path));
    }

    // Create a temporary prompt file to prevent command line length issues
    let mut temp_dir = std::env::temp_dir();
    let file_id = uuid::Uuid::new_v4().to_string();
    temp_dir.push(format!("localflow_prompt_{}.txt", file_id));

    let active_model_lower = active_model.to_lowercase();
    let (formatted_prompt, stop_token) = if active_model_lower.contains("llama") {
        (
            format!(
                "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nYou are a precise text post-processing assistant. Output only the final formatted text. Do not explain.<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n",
                prompt
            ),
            Some("<|eot_id|>")
        )
    } else if active_model_lower.contains("qwen") {
        (
            format!(
                "<|im_start|>system\nYou are a precise text post-processing assistant. Output only the final formatted text. Do not explain.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
                prompt
            ),
            Some("<|im_end|>")
        )
    } else {
        (prompt.to_string(), None)
    };

    fs::write(&temp_dir, &formatted_prompt)
        .map_err(|e| format!("Failed to write temporary prompt file: {}", e))?;

    println!("Running offline llama-cli inference with template wrapping...");
    let mut args = vec![
        "-m".to_string(),
        model_path.to_str().unwrap().to_string(),
        "-f".to_string(),
        temp_dir.to_str().unwrap().to_string(),
        "--temp".to_string(),
        "0.1".to_string(),
        "-n".to_string(),
        "512".to_string(),
        "--repeat-penalty".to_string(),
        "1.15".to_string(),
        "--no-display-prompt".to_string(),
    ];

    if let Some(stop) = stop_token {
        args.push("-r".to_string());
        args.push(stop.to_string());
    }

    let output = Command::new(&cli_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run llama-cli subprocess: {}", e))?;

    // Cleanup prompt file
    let _ = fs::remove_file(&temp_dir);

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Inference subprocess failed: {}", err_msg));
    }

    let mut result = String::from_utf8_lossy(&output.stdout).to_string();
    result = result.trim().to_string();

    Ok(result)
}

fn get_llm_setting(app: &AppHandle, key: &str, default: &str) -> String {
    if let Some(db_state) = app.try_state::<crate::db::DbState>() {
        let conn = db_state.0.lock().unwrap();
        let val: Result<String, _> =
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            });
        val.unwrap_or_else(|_| default.to_string())
    } else {
        default.to_string()
    }
}
