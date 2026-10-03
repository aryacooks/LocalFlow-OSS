use chrono::Utc;
/// db.rs — SQLite persistence for LocalFlow
/// Tables: dictation_history, dictionary, settings, style_memory
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct DbState(pub Mutex<Connection>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DictationEntry {
    pub id: i64,
    pub timestamp: String,
    pub app_name: String,
    pub app_exe: String,
    pub raw_text: String,
    pub cleaned_text: String,
    pub word_count: i64,
    pub duration_secs: f64,
    pub language: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DictionaryEntry {
    pub id: i64,
    pub term: String,
    pub pronunciation: String,
    pub replacement: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DashboardStats {
    pub total_words: i64,
    pub words_today: i64,
    pub avg_wpm_7d: f64,
    pub streak_days: i64,
    pub longest_streak: i64,
    pub total_dictations: i64,
    pub time_saved_minutes: f64,
    pub words_per_day: Vec<WordsPerDay>,
    pub top_apps: Vec<AppUsage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WordsPerDay {
    pub date: String,
    pub words: i64,
    pub wpm: f64,
    /// How many separate dictations happened that day. The dashboard rolls these
    /// up into week/month/year buckets, so the daily grain has to come through.
    pub dictations: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppUsage {
    pub app_name: String,
    pub word_count: i64,
    pub dictation_count: i64,
}

pub fn get_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("localflow.db");
    Ok(path)
}

pub fn init_db(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        CREATE TABLE IF NOT EXISTS dictation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            app_name TEXT NOT NULL DEFAULT '',
            app_exe TEXT NOT NULL DEFAULT '',
            raw_text TEXT NOT NULL DEFAULT '',
            cleaned_text TEXT NOT NULL DEFAULT '',
            word_count INTEGER NOT NULL DEFAULT 0,
            duration_secs REAL NOT NULL DEFAULT 0.0,
            language TEXT NOT NULL DEFAULT 'en',
            privacy_mode INTEGER NOT NULL DEFAULT 0
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS dictation_fts USING fts5(
            cleaned_text,
            content='dictation_history',
            content_rowid='id'
        );

        CREATE TABLE IF NOT EXISTS dictionary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            term TEXT NOT NULL UNIQUE,
            pronunciation TEXT NOT NULL DEFAULT '',
            replacement TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS style_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            cleaned_text TEXT NOT NULL,
            app_exe TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'Untitled',
            content TEXT NOT NULL DEFAULT '',
            folder TEXT NOT NULL DEFAULT 'default',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    ",
    )?;
    // Populating defaults
    let defaults = [
        ("shortcut_toggle", "Alt+F"),
        ("keybind_keyboard_vk", "67"),
        ("keybind_keyboard_name", "Alt+C"),
        ("keybind_keyboard_mode", "hold"),
        ("keybind_mouse_toggle", "none"),
        ("keybind_mouse_instant", "none"),
        ("track_apps", "true"),
        ("save_history", "true"),
        ("llm_active_model", "Llama-3.2-1B-Instruct-Q4_K_M.gguf"),
        ("llm_enabled", "false"),
        ("llm_system_prompt", ""),
        ("bubble_size", "auto"),
    ];

    for (key, val) in defaults {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .unwrap_or(0);

        if count == 0 {
            let _ = conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                [key, val],
            );
        }
    }

    // The bubble used to be sized by picking a laptop screen size ("13".."17"), which
    // mapped to a fixed multiplier. It is now a free multiplier the user steps up and
    // down. Carry a legacy choice over once so nobody's bubble silently resizes; the
    // old key is then dropped so this cannot run twice.
    let legacy_screen_size: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'screen_size'",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(legacy) = legacy_screen_size {
        let migrated = match legacy.as_str() {
            "13" => Some("1.00"),
            "14" => Some("1.10"),
            "15" => Some("1.20"),
            "16" => Some("1.30"),
            "17" => Some("1.38"),
            _ => None, // "auto" or unrecognised — leave bubble_size on its default
        };
        if let Some(value) = migrated {
            let _ = conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'bubble_size' AND value = 'auto'",
                [value],
            );
        }
        let _ = conn.execute("DELETE FROM settings WHERE key = 'screen_size'", []);
    }

    // Migrate old settings to new defaults
    let old_defaults = [
        ("shortcut_toggle", "Ctrl+Alt"),
        ("shortcut_toggle", "Ctrl+Shift+Space"),
        ("keybind_keyboard_name", "Ctrl+Q"),
        ("keybind_keyboard_vk", "81"),
    ];
    for (key, old_val) in old_defaults {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = ?1 AND value = ?2",
                [key, old_val],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            let new_val = match key {
                "shortcut_toggle" => "Alt+F",
                "keybind_keyboard_name" => "Alt+C",
                "keybind_keyboard_vk" => "67",
                _ => "",
            };
            let _ = conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = ?2",
                [new_val, key],
            );
        }
    }

    // Clean up old settings
    let _ = conn.execute("DELETE FROM settings WHERE key = 'keybind_keyboard'", []);
    let _ = conn.execute("DELETE FROM settings WHERE key IN ('keybind_mouse', 'keybind_mouse_name', 'keybind_mouse_mode')", []);

    Ok(())
}

// ─── Dictation History ───────────────────────────────────────────────────────

#[tauri::command]
pub fn save_dictation(
    db: State<'_, DbState>,
    raw_text: String,
    cleaned_text: String,
    app_name: String,
    app_exe: String,
    duration_secs: f64,
    language: String,
    privacy_mode: bool,
) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    let word_count = cleaned_text.split_whitespace().count() as i64;

    let save_history: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'save_history'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "true".to_string());

    if privacy_mode {
        return Ok(-1); // Don't persist in privacy mode
    }

    let final_raw = if save_history == "false" {
        String::new()
    } else {
        raw_text
    };
    let final_cleaned = if save_history == "false" {
        String::new()
    } else {
        cleaned_text
    };

    conn.execute(
        "INSERT INTO dictation_history (app_name, app_exe, raw_text, cleaned_text, word_count, duration_secs, language)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![app_name, app_exe, final_raw, final_cleaned, word_count, duration_secs, language],
    ).map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    // Update FTS index
    conn.execute(
        "INSERT INTO dictation_fts(rowid, cleaned_text) VALUES (?1, ?2)",
        params![id, final_cleaned],
    )
    .ok();

    if !final_cleaned.is_empty() {
        // Also add to style memory
        conn.execute(
            "INSERT INTO style_memory (cleaned_text, app_exe) VALUES (?1, ?2)",
            params![final_cleaned, app_exe],
        )
        .ok();

        // Keep style memory to last 50 entries
        conn.execute(
            "DELETE FROM style_memory WHERE id NOT IN (SELECT id FROM style_memory ORDER BY id DESC LIMIT 50)",
            [],
        ).ok();
    }

    Ok(id)
}

#[tauri::command]
pub fn get_history(
    db: State<'_, DbState>,
    search: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<DictationEntry>, String> {
    let conn = db.0.lock().unwrap();
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    let entries = if let Some(ref q) = search {
        if q.is_empty() {
            fetch_history_all(&conn, limit, offset)?
        } else {
            fetch_history_search(&conn, q, limit, offset)?
        }
    } else {
        fetch_history_all(&conn, limit, offset)?
    };

    Ok(entries)
}

fn fetch_history_all(
    conn: &Connection,
    limit: i64,
    offset: i64,
) -> Result<Vec<DictationEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, app_name, app_exe, raw_text, cleaned_text, word_count, duration_secs, language
             FROM dictation_history
             WHERE privacy_mode = 0
             ORDER BY id DESC
             LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map(params![limit, offset], map_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

fn fetch_history_search(
    conn: &Connection,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<DictationEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.timestamp, h.app_name, h.app_exe, h.raw_text, h.cleaned_text, h.word_count, h.duration_secs, h.language
             FROM dictation_history h
             JOIN dictation_fts f ON h.id = f.rowid
             WHERE f.dictation_fts MATCH ?1
             ORDER BY h.id DESC
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map(params![query, limit, offset], map_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DictationEntry> {
    Ok(DictationEntry {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        app_name: row.get(2)?,
        app_exe: row.get(3)?,
        raw_text: row.get(4)?,
        cleaned_text: row.get(5)?,
        word_count: row.get(6)?,
        duration_secs: row.get(7)?,
        language: row.get(8)?,
    })
}

#[tauri::command]
pub fn delete_history_entry(db: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM dictation_history WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dictation_fts WHERE rowid = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_history(db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM dictation_history", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dictation_fts", []).ok();
    Ok(())
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_dashboard_stats(db: State<'_, DbState>) -> Result<DashboardStats, String> {
    let conn = db.0.lock().unwrap();

    // Total words
    let total_words: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(word_count), 0) FROM dictation_history WHERE privacy_mode=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Words today
    let words_today: i64 = conn
        .query_row(
            // 'localtime' on both sides so "today" means the user's today, not UTC's.
            "SELECT COALESCE(SUM(word_count), 0) FROM dictation_history WHERE date(timestamp, 'localtime') = date('now', 'localtime') AND privacy_mode=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Total dictations
    let total_dictations: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM dictation_history WHERE privacy_mode=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Average WPM last 7 days (words / duration in minutes)
    let avg_wpm_7d: f64 = conn
        .query_row(
            "SELECT CASE WHEN SUM(duration_secs) > 0 THEN SUM(word_count) / (SUM(duration_secs) / 60.0) ELSE 0 END
             FROM dictation_history
             WHERE timestamp >= datetime('now', '-7 days') AND privacy_mode=0 AND duration_secs > 0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    // Streaks
    let (streak_days, longest_streak) = calculate_streaks(&conn);

    // Time saved: total_words / 60 WPM (baseline typing speed)
    let time_saved_minutes = total_words as f64 / 60.0;

    // Words per day (last 30 days)
    let words_per_day = get_words_per_day(&conn)?;

    // Top apps
    let top_apps = get_top_apps(&conn)?;

    Ok(DashboardStats {
        total_words,
        words_today,
        avg_wpm_7d,
        streak_days,
        longest_streak,
        total_dictations,
        time_saved_minutes,
        words_per_day,
        top_apps,
    })
}

fn calculate_streaks(conn: &Connection) -> (i64, i64) {
    let mut stmt = match conn.prepare(
        // Local days, matching the streak grid the frontend draws.
        "SELECT date(timestamp, 'localtime') as day, SUM(word_count) as total
         FROM dictation_history
         WHERE privacy_mode=0
         GROUP BY day
         ORDER BY day ASC",
    ) {
        Ok(s) => s,
        Err(_) => return (0, 0),
    };

    let mapped = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    });
    let days: Vec<(String, i64)> = match mapped {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    };

    if days.is_empty() {
        return (0, 0);
    }

    use chrono::NaiveDate;

    let mut current_streak = 0;
    let mut longest_streak = 0;
    let mut last_date: Option<NaiveDate> = None;

    for (day_str, words) in &days {
        if *words < 1 {
            continue;
        }

        let date = match NaiveDate::parse_from_str(day_str, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };

        match last_date {
            Some(last) => {
                let diff = (date - last).num_days();
                if diff == 1 {
                    current_streak += 1;
                } else if diff > 1 {
                    if current_streak > longest_streak {
                        longest_streak = current_streak;
                    }
                    current_streak = 1;
                }
            }
            None => {
                current_streak = 1;
            }
        }
        last_date = Some(date);
    }

    if current_streak > longest_streak {
        longest_streak = current_streak;
    }

    let today = Utc::now().naive_utc().date();
    let is_active = match last_date {
        Some(last) => {
            let diff = (today - last).num_days();
            diff <= 1
        }
        None => false,
    };

    if !is_active {
        current_streak = 0;
    }

    (current_streak, longest_streak)
}

fn get_words_per_day(conn: &Connection) -> Result<Vec<WordsPerDay>, String> {
    // Three years of daily grain. The dashboard's Day/Week/Month/Year views are all
    // rolled up from this one series on the frontend, so the window has to be long
    // enough for a couple of full years of history.
    //
    // Grouped by LOCAL date: timestamps are stored as UTC (`datetime('now')`), while
    // the UI thinks in the user's own days. Without 'localtime' a late-evening
    // dictation lands on tomorrow for anyone east of UTC.
    let mut stmt = conn
        .prepare(
            "SELECT date(timestamp, 'localtime') as day,
                    SUM(word_count) as words,
                    CASE WHEN SUM(duration_secs) > 0
                         THEN SUM(word_count) / (SUM(duration_secs) / 60.0)
                         ELSE 0 END as wpm,
                    COUNT(*) as dictations
             FROM dictation_history
             WHERE timestamp >= datetime('now', '-1095 days') AND privacy_mode=0
             GROUP BY day
             ORDER BY day ASC",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map([], |row| {
            Ok(WordsPerDay {
                date: row.get(0)?,
                words: row.get(1)?,
                wpm: row.get(2)?,
                dictations: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

fn get_top_apps(conn: &Connection) -> Result<Vec<AppUsage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT app_name, SUM(word_count) as total_words, COUNT(*) as dictation_count
             FROM dictation_history
             WHERE privacy_mode=0 AND app_name != ''
             GROUP BY app_exe
             ORDER BY total_words DESC
             LIMIT 8",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map([], |row| {
            Ok(AppUsage {
                app_name: row.get(0)?,
                word_count: row.get(1)?,
                dictation_count: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

// ─── Dictionary ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_dictionary(db: State<'_, DbState>) -> Result<Vec<DictionaryEntry>, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, term, pronunciation, replacement FROM dictionary ORDER BY term ASC")
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map([], |row| {
            Ok(DictionaryEntry {
                id: row.get(0)?,
                term: row.get(1)?,
                pronunciation: row.get(2)?,
                replacement: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

#[tauri::command]
pub fn add_dictionary_entry(
    db: State<'_, DbState>,
    term: String,
    pronunciation: String,
    replacement: String,
) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO dictionary (term, pronunciation, replacement) VALUES (?1, ?2, ?3)",
        params![term, pronunciation, replacement],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn delete_dictionary_entry(db: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM dictionary WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_dictionary_prompt(db: State<'_, DbState>) -> String {
    let conn = db.0.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT term FROM dictionary ORDER BY term ASC") {
        Ok(s) => s,
        Err(_) => return String::new(),
    };

    let terms: Vec<String> = match stmt.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    };

    if terms.is_empty() {
        String::new()
    } else {
        format!("Vocabulary: {}. ", terms.join(", "))
    }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_setting(db: State<'_, DbState>, key: String) -> Option<String> {
    // The OpenRouter key is write-only from the UI's side; `get_stt_status` reports
    // whether one is set and a masked form.
    if key == crate::OPENROUTER_KEY_SETTING {
        return None;
    }
    let conn = db.0.lock().unwrap();
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

#[tauri::command]
pub fn set_setting(db: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_all_settings(db: State<'_, DbState>) -> Result<serde_json::Value, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;

    let mut map = serde_json::Map::new();
    stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .filter(|(k, _)| k != crate::OPENROUTER_KEY_SETTING)
    .for_each(|(k, v)| {
        map.insert(k, serde_json::Value::String(v));
    });

    Ok(serde_json::Value::Object(map))
}

// ─── Notes ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn get_notes(db: State<'_, DbState>) -> Result<Vec<Note>, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, title, content, folder, created_at, updated_at FROM notes ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;

    let notes = stmt
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(notes)
}

#[tauri::command]
pub fn save_note(
    db: State<'_, DbState>,
    id: String,
    title: String,
    content: String,
    folder: String,
) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, content, folder) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, folder=excluded.folder, updated_at=datetime('now')",
        params![id, title, content, folder],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_note(db: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
