# 一键启动：首次运行会创建 venv 并安装依赖。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.venv\Scripts\python.exe')) {
    Write-Host '[jls] 创建虚拟环境…'
    py -3.12 -m venv .venv
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

.\.venv\Scripts\python.exe -c "import sys; sys.exit(sys.version_info < (3, 11))"
if ($LASTEXITCODE -ne 0) {
    Write-Error '需要 Python 3.11+。请保留或重命名旧 .venv，再用 Python 3.12 运行此脚本。'
    exit 1
}

$pipVersion = .\.venv\Scripts\python.exe -c "import importlib.metadata; print(importlib.metadata.version('pip'))"
if ([version]$pipVersion -lt [version]'26.2') {
    .\.venv\Scripts\python.exe -m pip install --upgrade 'pip>=26.2'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
.\.venv\Scripts\python.exe -m pip install -q -r requirements.txt
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $env:DEEPSEEK_API_KEY -and -not (Test-Path 'config.local.json')) {
    Write-Warning '未找到 DeepSeek API Key，当前仅显示日语。需要翻译时可设置 DEEPSEEK_API_KEY 或本机配置。'
}

$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
Write-Host '[jls] 打开 http://127.0.0.1:8765/'
.\.venv\Scripts\python.exe -m server.app @args
