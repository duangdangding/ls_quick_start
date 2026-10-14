# Windows 代码签名脚本
# 用法: sign-windows.ps1 <file-to-sign>
# 证书路径和密码通过环境变量传入: WINDOWS_CERT_PATH, WINDOWS_CERT_PASSWORD

param([Parameter(Mandatory=$true)][string]$FileToSign)

$certPath = $env:WINDOWS_CERT_PATH
$certPassword = $env:WINDOWS_CERT_PASSWORD

if (-not $certPath -or -not $certPassword) {
    Write-Host "跳过签名: 未配置 WINDOWS_CERT_PATH / WINDOWS_CERT_PASSWORD"
    exit 0
}

# 定位 signtool
$signtool = $env:TAURI_WINDOWS_SIGNTOOL_PATH
if (-not $signtool) {
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}
if (-not $signtool) {
    $sdkDirs = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    foreach ($dir in $sdkDirs) {
        $candidate = Join-Path $dir.FullName "x64\signtool.exe"
        if (Test-Path $candidate) { $signtool = $candidate; break }
    }
}
if (-not $signtool) { Write-Error "找不到 signtool.exe"; exit 1 }

& $signtool sign /fd sha256 /td sha256 /tr http://timestamp.digicert.com /f $certPath /p $certPassword $FileToSign
if ($LASTEXITCODE -ne 0) { Write-Error "签名失败"; exit $LASTEXITCODE }
Write-Host "签名成功: $FileToSign"
