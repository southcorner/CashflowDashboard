# ──────────────────────────────────────────────────────────────
#  Space Goods — Cashflow Dashboard Launcher
#  Single click: starts the server + opens browser
#  Click again:  stops the server
# ──────────────────────────────────────────────────────────────

$appDir  = "C:\Users\ASUS\Documents\Company documents\Vivek Documents\CashflowDashboard"
$pidFile = "$env:TEMP\sg_dashboard.pid"
$port    = 5000
$url     = "http://localhost:$port"

# ── Balloon-tip notification (non-blocking) ──
function Show-Tip($title, $msg) {
    Add-Type -AssemblyName System.Windows.Forms
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon             = [System.Drawing.SystemIcons]::Application
    $n.BalloonTipTitle  = $title
    $n.BalloonTipText   = $msg
    $n.Visible          = $true
    $n.ShowBalloonTip(4000)
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Seconds 2
    $n.Dispose()
}

# ── Check if the tracked process is still alive ──
function Test-Running {
    if (-not (Test-Path $pidFile)) { return $false }
    $id = [int](Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
    if (-not $id) { return $false }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    return ($null -ne $p -and -not $p.HasExited)
}

# ── Wait until port is listening (max ~10 s) ──
function Wait-Port($port) {
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect("127.0.0.1", $port)
            $tcp.Close()
            return $true
        } catch {}
    }
    return $false
}

# ════════════════════════════════════════════════════════════════
if (Test-Running) {

    # ── STOP ──────────────────────────────────────────────────
    $id = [int](Get-Content $pidFile -Raw)
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Show-Tip "Space Goods" "Dashboard stopped."

} else {

    # ── START ─────────────────────────────────────────────────
    # Clean up stale pid file if any
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

    $proc = Start-Process python `
        -ArgumentList "app.py" `
        -WorkingDirectory $appDir `
        -PassThru `
        -WindowStyle Hidden

    # Save PID so we can stop it later
    $proc.Id | Out-File $pidFile -Encoding ASCII -NoNewline

    if (Wait-Port $port) {
        Start-Process $url
        Show-Tip "Space Goods" "Dashboard is running.`nClick again to stop."
    } else {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        Show-Tip "Space Goods" "Failed to start. Check Python is installed and dependencies are present."
    }
}
