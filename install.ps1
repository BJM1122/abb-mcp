#requires -Version 7.0
[CmdletBinding()]
param([switch]$SkipCredential)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This distribution requires Windows (DPAPI credentials).' }
$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'Install Node.js 20 or newer first.' }
Push-Location $PSScriptRoot
try {
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & $npm run build:native
    if ($LASTEXITCODE -ne 0) { throw 'Native credential helper build failed.' }
    $registryPath = Join-Path $PSScriptRoot 'controller-registry.json'
    $dataRoot = Join-Path $PSScriptRoot 'artifacts'
    New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot 'staging') | Out-Null
    if (-not (Test-Path -LiteralPath $registryPath)) {
        $registry = [ordered]@{
            version = 1
            rwsHelperPath = Join-Path $PSScriptRoot 'legacy/abb_rws_session.ps1'
            allowedLocalRoots = @($dataRoot)
            allowedConfigDomains = @('eio','sio','sys','proc')
            controllers = @{}
        }
        # Never seed a real controller or overwrite an existing local registry.
        $content = $registry | ConvertTo-Json -Depth 8
        $stream = [IO.File]::Open($registryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($content)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    }
    if (-not $SkipCredential) { & (Join-Path $PSScriptRoot 'provision-credential.ps1') }
    & $node (Join-Path $PSScriptRoot 'abbctl.mjs') health
    if ($LASTEXITCODE -ne 0) { throw 'MCP health check failed.' }
    $serverPath = Join-Path $PSScriptRoot 'server.mjs'
    Write-Host 'Installed. Add this local stdio server to your MCP client:'
    @{ mcpServers = @{ abb_local = @{ command = $node; args = @($serverPath); env = @{ ABB_MCP_CHANGESET_BACKEND = 'direct-rws-preview'; ABB_MCP_ALLOW_LEGACY = '0' } } } } | ConvertTo-Json -Depth 8
    Write-Host 'No controller is connected. Follow README.md to create your own local controller entry.'
} finally { Pop-Location }
