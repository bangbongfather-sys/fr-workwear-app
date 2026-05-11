# 간단한 PowerShell HTTP 서버 (Python/Node 없이 작동)
# 사용법: 우클릭 → PowerShell로 실행
$root = "C:\Users\magic\OneDrive\바탕 화면\fr-workwear-app"
$port = 8765
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "✅ NJ SAFETY 로컬 서버 시작" -ForegroundColor Green
Write-Host "   http://localhost:$port/" -ForegroundColor Cyan
Write-Host "   (브라우저에서 자동으로 열립니다)" -ForegroundColor Gray
Write-Host "   중지하려면 Ctrl+C" -ForegroundColor Yellow
Start-Process "http://localhost:$port/"
$mime = @{
    ".html"="text/html;charset=utf-8"; ".js"="application/javascript;charset=utf-8";
    ".css"="text/css;charset=utf-8"; ".json"="application/json;charset=utf-8";
    ".png"="image/png"; ".jpg"="image/jpeg"; ".gif"="image/gif"; ".svg"="image/svg+xml";
    ".ico"="image/x-icon"; ".txt"="text/plain;charset=utf-8"
}
try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        $path = [System.Web.HttpUtility]::UrlDecode($req.Url.LocalPath)
        if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }
        $filePath = Join-Path $root $path.TrimStart("/").Replace("/", "\")
        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $contentType = if ($mime[$ext]) { $mime[$ext] } else { "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $res.ContentType = $contentType
            $res.ContentLength64 = $bytes.Length
            $res.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "  200 $path" -ForegroundColor DarkGray
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
            $res.OutputStream.Write($msg, 0, $msg.Length)
            Write-Host "  404 $path" -ForegroundColor Red
        }
        $res.Close()
    }
} finally {
    $listener.Stop()
    Write-Host "서버 중지됨" -ForegroundColor Yellow
}
