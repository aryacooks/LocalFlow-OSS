@echo off
REM LocalFlow Build Setup Script
REM Run this AFTER installing LLVM from https://github.com/llvm/llvm-project/releases
REM Make sure to select "Add LLVM to PATH" during LLVM installation

echo ========================================
echo LocalFlow Build Setup
echo ========================================

REM Check for LLVM
where clang >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: clang not found in PATH
    echo Please install LLVM from: https://github.com/llvm/llvm-project/releases
    echo During installation, select "Add LLVM to PATH for all users"
    exit /b 1
)

echo [OK] LLVM/Clang found:
clang --version

REM Set LIBCLANG_PATH for whisper-rs bindgen
for /f "delims=" %%i in ('where clang') do set CLANG_PATH=%%i
for %%i in ("%CLANG_PATH%") do set CLANG_DIR=%%~dpi
set LIBCLANG_PATH=%CLANG_DIR%

echo [OK] LIBCLANG_PATH set to: %LIBCLANG_PATH%

REM Check for Rust
rustc --version >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Rust not found. Install from https://rustup.rs
    exit /b 1
)
echo [OK] Rust:
rustc --version

REM Check for Node/pnpm
pnpm --version >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: pnpm not found. Run: npm install -g pnpm
    exit /b 1
)
echo [OK] pnpm:
pnpm --version

echo.
echo ========================================
echo Building LocalFlow...
echo ========================================

REM Install frontend deps
pnpm install

REM Run Tauri build
set LIBCLANG_PATH=%LIBCLANG_PATH%
pnpm tauri build

echo.
echo Build complete! MSI installer at:
echo src-tauri\target\release\bundle\msi\
