#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $env:USERPROFILE '.abb-mcp/secrets/controller.clixml'),
    [System.Management.Automation.PSCredential]$Credential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows DPAPI credentials require Windows.' }
if (Test-Path -LiteralPath $OutputPath) { throw 'Credential file already exists. Choose a different OutputPath; existing credentials are never overwritten.' }
if ($null -eq $Credential) { $Credential = Get-Credential -Message 'Enter YOUR ABB controller RWS account. The password stays on this Windows account.' }
if ($null -eq $Credential -or [string]::IsNullOrWhiteSpace($Credential.UserName)) { throw 'Credential entry cancelled or empty.' }
$parent = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$Credential | Export-Clixml -LiteralPath $OutputPath -NoClobber
$check = Import-Clixml -LiteralPath $OutputPath
if ($check -isnot [System.Management.Automation.PSCredential] -or $check.UserName -ne $Credential.UserName) { throw 'Credential verification failed.' }
Write-Host "Saved Windows current-user DPAPI credential: $OutputPath"
Write-Host 'Use this credentialFile path in your local controller registry. Do not upload or copy it to another user/computer.'
