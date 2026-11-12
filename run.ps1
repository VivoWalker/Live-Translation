# 一键启动：首次运行会创建 venv 并安装依赖。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.venv\Scripts\python.exe')) {
    Write-Host '[jls] 创建虚拟环境…'
    py -3.10 -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt
}

if (-not $env:DEEPSEEK_API_KEY -and -not (Test-Path 'config.local.json')) {
    Write-Warning '未找到 DeepSeek API Key：复制 config.example.json 为 config.local.json 并填入 key，或设置 $env:DEEPSEEK_API_KEY。当前会退回公共翻译端点。'
}

$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
Write-Host '[jls] 打开 http://127.0.0.1:8765/'
.\.venv\Scripts\python.exe -m server.app @args
