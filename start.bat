@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm wurde nicht gefunden. Bitte Node.js installieren.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installiere Abhaengigkeiten...
  call npm install
  if errorlevel 1 (
    echo Installation fehlgeschlagen.
    pause
    exit /b 1
  )
)

echo Starte Chart_Replay_Tool auf http://127.0.0.1:8788/
call npm run dev

endlocal
