@echo off
chcp 65001 >nul
title 标题雷达本地服务
cd /d "%~dp0"

powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/' -TimeoutSec 1; if ($r.StatusCode -lt 500) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  start "" "http://localhost:3000/"
  exit /b 0
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js 或 npm，请先安装 Node.js。
  pause
  exit /b 1
)

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$u = 'http://localhost:3000/'; for ($i = 0; $i -lt 90; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 1; if ($r.StatusCode -lt 500) { Start-Process $u; exit } } catch {}; Start-Sleep -Seconds 1 }"

echo 正在启动标题雷达，请保持此窗口开启……
echo 启动完成后会自动打开浏览器：http://localhost:3000/
echo.
call npm run dev -- --host 0.0.0.0

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
