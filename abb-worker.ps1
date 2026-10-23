#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RegistryPath = (Join-Path $PSScriptRoot 'controller-registry.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
    throw "Controller registry not found: $RegistryPath"
}

$script:RegistryPath = [IO.Path]::GetFullPath($RegistryPath)
$script:Registry = Get-Content -LiteralPath $script:RegistryPath -Raw | ConvertFrom-Json
$registryItem = Get-Item -LiteralPath $script:RegistryPath
$script:RegistryStamp = "$($registryItem.LastWriteTimeUtc.Ticks):$($registryItem.Length)"
$script:Bindings = @{}
$script:PreparedJobs = @{}
$script:PreparedBackups = @{}
$script:Metrics = @{}
$script:ConfigListCache = @{}
$script:ControllerTransportFailures = @{}
$script:CurrentWorkerRequestId = $null
$script:BuiltInSafeConfigDomains = @('eio','sio','sys','proc')
$offlineCooldownMs = 5000
if (-not [string]::IsNullOrWhiteSpace($env:ABB_MCP_OFFLINE_COOLDOWN_MS)) {
    $parsedOfflineCooldownMs = 0
    if (-not [int]::TryParse(
        $env:ABB_MCP_OFFLINE_COOLDOWN_MS,
        [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsedOfflineCooldownMs
    ) -or $parsedOfflineCooldownMs -lt 500 -or $parsedOfflineCooldownMs -gt 60000) {
        throw 'ABB_MCP_OFFLINE_COOLDOWN_MS must be an integer between 500 and 60000.'
    }
    $offlineCooldownMs = $parsedOfflineCooldownMs
}
$script:OfflineCooldownMs = $offlineCooldownMs

$helperPath = [Environment]::ExpandEnvironmentVariables([string]$script:Registry.rwsHelperPath)
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "RWS helper not found: $helperPath"
}
. $helperPath

$script:BackupLibraryPath = Join-Path $PSScriptRoot 'backup-controller.ps1'
$script:BackupLibraryLoaded = $false
if (-not (Test-Path -LiteralPath $script:BackupLibraryPath -PathType Leaf)) {
    throw "ABB backup library not found: $($script:BackupLibraryPath)"
}

function Import-AbbBackupLibrary {
    if ($script:BackupLibraryLoaded) { return }
    $moduleName = 'AbbMcpBackupLibrary'
    try {
        $module = New-Module `
            -Name $moduleName `
            -ArgumentList $script:BackupLibraryPath,$script:RegistryPath `
            -ScriptBlock {
                param($LibraryPath, $RegistryPath)
                . $LibraryPath -LibraryOnly -RegistryPath $RegistryPath
                Export-ModuleMember -Function @(
                    'Assert-SafeRemotePathSegment',
                    'Invoke-BackupCallback',
                    'Resolve-AllowedLocalRoot',
                    'Test-AbbCollisionResistantBackupName',
                    'Get-AbbRemoteBackupSnapshot',
                    'Invoke-AbbControllerBackup',
                    'Test-AbbBackupManifest'
                )
            }
        Import-Module $module -Global -Force -DisableNameChecking
        foreach ($command in @(
            'Assert-SafeRemotePathSegment',
            'Invoke-BackupCallback',
            'Resolve-AllowedLocalRoot',
            'Test-AbbCollisionResistantBackupName',
            'Get-AbbRemoteBackupSnapshot',
            'Invoke-AbbControllerBackup',
            'Test-AbbBackupManifest'
        )) {
            if ($null -eq (Get-Command $command -ErrorAction SilentlyContinue)) {
                throw "ABB backup library did not export required command: $command"
            }
        }
        $script:BackupLibraryLoaded = $true
    }
    catch {
        Remove-Module $moduleName -Force -ErrorAction SilentlyContinue
        throw
    }
}

# The shared helper requires non-empty response bodies. RW6 legitimately returns
# empty bodies for many successful HTTP 204 operations, so make flattening tolerant.
function ConvertTo-AbbFlatText {
    param([AllowEmptyString()][string]$Text = '')
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return (($Text -replace '<[^>]+>', ' ') -replace '\s+', ' ').Trim()
}

function Get-ObjectProperty {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Required
    )
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        if ($Required) { throw "Missing required property: $Name" }
        return $null
    }
    return $property.Value
}

function Get-ConfigTimeoutSeconds {
    param(
        [Parameter(Mandatory = $true)][object]$Config,
        [ValidateSet('request','long')][string]$Kind = 'request'
    )
    $name = if ($Kind -eq 'long') { 'longRequestTimeoutSeconds' } else { 'requestTimeoutSeconds' }
    $fallback = if ($Kind -eq 'long') { 60 } else { 5 }
    $value = Get-ObjectProperty -Object $Config -Name $name
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { return $fallback }
    $seconds = [int]$value
    if ($seconds -lt 1 -or $seconds -gt 1800) { throw "$name must be between 1 and 1800 seconds." }
    return $seconds
}

function Get-ControllerConfigSignature {
    param([Parameter(Mandatory = $true)][object]$Config)
    return [pscustomobject]@{
        baseUrl = [string](Get-ObjectProperty -Object $Config -Name 'baseUrl')
        expectedName = [string](Get-ObjectProperty -Object $Config -Name 'expectedName')
        expectedSystemId = Normalize-SystemId ([string](Get-ObjectProperty -Object $Config -Name 'expectedSystemId'))
        expectedRobotWare = [string](Get-ObjectProperty -Object $Config -Name 'expectedRobotWare')
        username = [string](Get-ObjectProperty -Object $Config -Name 'username')
        credentialFile = [string](Get-ObjectProperty -Object $Config -Name 'credentialFile')
        defaultTask = [string](Get-ObjectProperty -Object $Config -Name 'defaultTask')
        ioNetwork = [string](Get-ObjectProperty -Object $Config -Name 'ioNetwork')
        ioDevice = [string](Get-ObjectProperty -Object $Config -Name 'ioDevice')
        requestTimeoutSeconds = Get-ConfigTimeoutSeconds -Config $Config -Kind request
        longRequestTimeoutSeconds = Get-ConfigTimeoutSeconds -Config $Config -Kind long
    } | ConvertTo-Json -Compress
}

function Normalize-SystemId {
    param([AllowEmptyString()][string]$Value = '')
    return $Value.Trim().Trim('{}').ToLowerInvariant()
}

function Get-ControllerConfig {
    param([Parameter(Mandatory = $true)][string]$Alias)
    $property = $script:Registry.controllers.PSObject.Properties[$Alias]
    if ($null -eq $property) { throw "Unknown controller alias: $Alias" }
    return $property.Value
}

function Resolve-RegistryPathValue {
    param([Parameter(Mandatory = $true)][string]$Value)
    $expanded = [Environment]::ExpandEnvironmentVariables($Value)
    if ([IO.Path]::IsPathRooted($expanded)) { return [IO.Path]::GetFullPath($expanded) }
    return [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $script:RegistryPath) $expanded))
}

function Assert-ControllerAliasValue {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [string]$Label = 'alias'
    )
    if ($Value -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$') {
        throw "$Label must match ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$ (maximum 64 characters)."
    }
    return $Value
}

function ConvertTo-StrictTimeoutSeconds {
    param(
        [object]$Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Default,
        [Parameter(Mandatory = $true)][int]$Minimum,
        [Parameter(Mandatory = $true)][int]$Maximum
    )
    if ($null -eq $Value) { return $Default }

    $text = [Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture)
    $seconds = 0
    if (-not [int]::TryParse(
        $text,
        [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$seconds
    )) {
        throw "$Name must be an integer between $Minimum and $Maximum."
    }
    if ($seconds -lt $Minimum -or $seconds -gt $Maximum) {
        throw "$Name must be between $Minimum and $Maximum seconds."
    }
    return $seconds
}

function Resolve-ControllerRootEndpoint {
    param([Parameter(Mandatory = $true)][object]$Value)

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text) -or $text -ne $text.Trim()) {
        throw 'baseUrl must be a non-empty absolute http/https root URL without surrounding whitespace.'
    }

    $uri = $null
    if (-not [Uri]::TryCreate($text, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http','https') -or
        [string]::IsNullOrWhiteSpace($uri.Host)) {
        throw 'baseUrl must be an absolute http/https root URL.'
    }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or
        $uri.AbsolutePath -ne '/') {
        throw 'baseUrl must contain only the http/https scheme, host, and optional port; paths, credentials, query strings, and fragments are not allowed.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Get-RequiredNonEmptyString {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $value = [string](Get-ObjectProperty -Object $Object -Name $Name -Required)
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name must not be empty." }
    return $value
}

function Invoke-ControllerIdentityProbe {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$CredentialAlias,
        [Parameter(Mandatory = $true)][int]$RequestTimeoutSeconds,
        [object]$CredentialConfig
    )

    $endpoint = Resolve-ControllerRootEndpoint -Value $BaseUrl
    $null = Assert-ControllerAliasValue -Value $CredentialAlias -Label 'credentialAlias'
    if ($RequestTimeoutSeconds -lt 1 -or $RequestTimeoutSeconds -gt 30) {
        throw 'requestTimeoutSeconds must be between 1 and 30 seconds.'
    }
    if ($null -eq $CredentialConfig) {
        $CredentialConfig = Get-ControllerConfig -Alias $CredentialAlias
    }

    $username = [string](Get-ObjectProperty -Object $CredentialConfig -Name 'username' -Required)
    $credentialReference = [string](Get-ObjectProperty -Object $CredentialConfig -Name 'credentialFile' -Required)
    if ([string]::IsNullOrWhiteSpace($username)) { throw "Registered credential alias '$CredentialAlias' has an empty username." }
    if ([string]::IsNullOrWhiteSpace($credentialReference)) { throw "Registered credential alias '$CredentialAlias' has an empty credentialFile." }

    $credentialPath = Resolve-RegistryPathValue -Value $credentialReference
    if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        throw "DPAPI credential file missing: $credentialPath. Run provision-credential.ps1 first."
    }

    $started = [Diagnostics.Stopwatch]::StartNew()
    $credential = $null
    $password = $null
    $session = $null
    $probeResponded = $false
    $identity = $null
    try {
        $credential = Import-Clixml -LiteralPath $credentialPath
        if ($credential -isnot [System.Management.Automation.PSCredential]) {
            throw "Credential file is not a PSCredential: $credentialPath"
        }
        $password = $credential.GetNetworkCredential().Password
        $session = New-AbbRwsSession `
            -BaseUrl $endpoint `
            -Username $username `
            -Password $password `
            -RequestTimeoutSeconds $RequestTimeoutSeconds

        # Deliberately probe exactly one known RWS identity path. There is no
        # alternate-path guessing and no retry for transport or HTTP failures.
        $response = Invoke-AbbRwsRequest `
            -Session $session `
            -Method GET `
            -Path '/rw/system?json=1' `
            -TimeoutSeconds $RequestTimeoutSeconds
        $probeResponded = $true
        $identity = Convert-SystemResponseToIdentity -Response $response
    }
    finally {
        if ($null -ne $session) {
            if ($probeResponded) {
                try {
                    $null = Invoke-AbbRwsRequest -Session $session -Method GET -Path '/logout' -TimeoutSeconds 1
                } catch {}
            }
            Close-AbbRwsSession -Session $session
        }
        $password = $null
        $credential = $null
        $started.Stop()
    }

    return [pscustomobject]@{
        Endpoint = $endpoint
        Identity = $identity
        ElapsedMs = $started.ElapsedMilliseconds
        ControllerModified = $false
    }
}

function Write-ControllerRegistryEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [Parameter(Mandatory = $true)][object]$Entry,
        [Parameter(Mandatory = $true)][string]$CredentialAlias,
        [Parameter(Mandatory = $true)][string]$ExpectedUsername,
        [Parameter(Mandatory = $true)][string]$ExpectedCredentialFile
    )

    $registryItem = Get-Item -LiteralPath $script:RegistryPath
    $originalStamp = "$($registryItem.LastWriteTimeUtc.Ticks):$($registryItem.Length)"
    $registry = Get-Content -LiteralPath $script:RegistryPath -Raw | ConvertFrom-Json
    $credentialProperty = $registry.controllers.PSObject.Properties[$CredentialAlias]
    if ($null -eq $credentialProperty) {
        throw "Credential alias disappeared during probe: $CredentialAlias"
    }
    $currentUsername = [string](Get-ObjectProperty -Object $credentialProperty.Value -Name 'username' -Required)
    $currentCredentialFile = [string](Get-ObjectProperty -Object $credentialProperty.Value -Name 'credentialFile' -Required)
    if (-not [string]::Equals($currentUsername, $ExpectedUsername, [StringComparison]::Ordinal) -or
        -not [string]::Equals($currentCredentialFile, $ExpectedCredentialFile, [StringComparison]::Ordinal)) {
        throw "Credential alias changed during probe: $CredentialAlias. Probe again before registering."
    }

    $existing = $registry.controllers.PSObject.Properties[$Alias]
    if ($null -ne $existing) { $registry.controllers.PSObject.Properties.Remove($Alias) }
    $registry.controllers | Add-Member -NotePropertyName $Alias -NotePropertyValue $Entry

    $temporary = "$($script:RegistryPath).$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = ($registry | ConvertTo-Json -Depth 20) + [Environment]::NewLine
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))

        $currentItem = Get-Item -LiteralPath $script:RegistryPath
        $currentStamp = "$($currentItem.LastWriteTimeUtc.Ticks):$($currentItem.Length)"
        if ($currentStamp -ne $originalStamp) {
            throw 'Controller registry changed while the registration update was being prepared. Retry the registration.'
        }
        [IO.File]::Move($temporary, $script:RegistryPath, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Resolve-AllowedLocalFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Extensions = @()
    )
    $resolved = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
    $allowed = $false
    foreach ($rootValue in @($script:Registry.allowedLocalRoots)) {
        $root = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$rootValue)).TrimEnd('\') + '\'
        if ($resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            $allowed = $true
            break
        }
    }
    if (-not $allowed) { throw "Local file is outside allowed roots: $resolved" }
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Local file not found: $resolved" }
    if ($Extensions.Count -gt 0 -and [IO.Path]::GetExtension($resolved).ToLowerInvariant() -notin $Extensions) {
        throw "Unsupported file extension for $resolved"
    }
    return $resolved
}

function Get-Sha256File {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Bytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Convert-BytesToText {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $stream = [IO.MemoryStream]::new($Bytes, $false)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() }
    finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-Sha256Text {
    param([AllowEmptyString()][string]$Text = '')
    $normalized = (($Text -replace "`r`n", "`n") -replace "`r", "`n").Trim()
    $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Assert-HttpStatus {
    param(
        [Parameter(Mandatory = $true)][object]$Response,
        [Parameter(Mandatory = $true)][int[]]$Allowed,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    if ($Response.StatusCode -notin $Allowed) {
        throw "$Operation failed HTTP $($Response.StatusCode): $($Response.FlatBody)"
    }
}

function Convert-SystemResponseToIdentity {
    param([Parameter(Mandatory = $true)][object]$Response)
    $response = $Response
    Assert-HttpStatus -Response $response -Allowed @(200) -Operation 'Read controller identity'
    $system = @(($response.Body | ConvertFrom-Json)._embedded._state) |
        Where-Object { $_._type -eq 'sys-system-li' } | Select-Object -First 1
    if ($null -eq $system) { throw 'Controller identity payload did not contain sys-system-li.' }
    return [pscustomobject]@{
        Name = [string]$system.name
        SystemId = Normalize-SystemId ([string]$system.sysid)
        RobotWare = [string]$system.rwversion
    }
}

function Get-AliasMetrics {
    param([Parameter(Mandatory = $true)][string]$Alias)
    if (-not $script:Metrics.ContainsKey($Alias)) {
        $script:Metrics[$Alias] = [pscustomobject]@{
            RequestCount = 0
            SessionCreateCount = 0
            ReconnectCount = 0
            TimeoutCount = 0
            TransportFailureCount = 0
            CircuitFastFailCount = 0
        }
    }
    return $script:Metrics[$Alias]
}

function Copy-AliasMetrics {
    param([Parameter(Mandatory = $true)][string]$Alias)
    $metrics = Get-AliasMetrics -Alias $Alias
    return [pscustomobject]@{
        RequestCount = [int]$metrics.RequestCount
        SessionCreateCount = [int]$metrics.SessionCreateCount
        ReconnectCount = [int]$metrics.ReconnectCount
        TimeoutCount = [int]$metrics.TimeoutCount
        TransportFailureCount = [int]$metrics.TransportFailureCount
        CircuitFastFailCount = [int]$metrics.CircuitFastFailCount
    }
}

function Get-IdentityFromSession {
    param(
        [Parameter(Mandatory = $true)][object]$Session,
        [object]$Metrics
    )
    try {
        $response = Invoke-AbbRwsRequest -Session $Session -Method GET -Path '/rw/system?json=1'
        if ($null -ne $Metrics) { $Metrics.RequestCount++ }
        return Convert-SystemResponseToIdentity -Response $response
    }
    catch {
        if ($null -ne $Metrics -and $_.Exception.Message -match '(?i)timed out|timeout') { $Metrics.TimeoutCount++ }
        throw
    }
}

function Get-BindingIdentity {
    param([Parameter(Mandatory = $true)][object]$Binding)
    $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path '/rw/system?json=1'
    return Convert-SystemResponseToIdentity -Response $response
}

function Get-BindingIdentityForRead {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [ValidateRange(0, 60)][int]$MaxAgeSeconds = 5
    )
    $verifiedAtUtc = [DateTime]::MinValue
    try {
        $verifiedAtUtc = ([DateTimeOffset]::Parse([string]$Binding.VerifiedAt)).UtcDateTime
    }
    catch {}
    $ageMs = [Math]::Max(0, [long]([DateTime]::UtcNow - $verifiedAtUtc).TotalMilliseconds)
    if ($null -ne $Binding.Identity -and $ageMs -le ($MaxAgeSeconds * 1000)) {
        return [pscustomobject]@{
            Identity = $Binding.Identity
            CacheHit = $true
            AgeMs = $ageMs
        }
    }

    $identity = Get-BindingIdentity -Binding $Binding
    Assert-ExpectedIdentity -Identity $identity -Config $Binding.Config
    $Binding.Identity = $identity
    $Binding.VerifiedAt = (Get-Date).ToString('o')
    return [pscustomobject]@{
        Identity = $identity
        CacheHit = $false
        AgeMs = 0
    }
}

function Assert-ExpectedIdentity {
    param(
        [Parameter(Mandatory = $true)][object]$Identity,
        [Parameter(Mandatory = $true)][object]$Config
    )
    $expectedSystemId = Normalize-SystemId ([string]$Config.expectedSystemId)
    if ($Identity.Name -ne [string]$Config.expectedName -or $Identity.SystemId -ne $expectedSystemId) {
        throw "CONTROLLER IDENTITY MISMATCH: actual=$($Identity.Name)/$($Identity.SystemId), expected=$($Config.expectedName)/$expectedSystemId"
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.expectedRobotWare) -and
        $Identity.RobotWare -ne [string]$Config.expectedRobotWare) {
        throw "ROBOTWARE MISMATCH: actual=$($Identity.RobotWare), expected=$($Config.expectedRobotWare)"
    }
}

function Test-ControllerTransportFailure {
    param([Parameter(Mandatory = $true)][Exception]$Exception)

    $current = $Exception
    while ($null -ne $current) {
        if (
            $current -is [TimeoutException] -or
            $current -is [Net.Http.HttpRequestException] -or
            $current -is [Net.Sockets.SocketException] -or
            $current -is [Threading.Tasks.TaskCanceledException]
        ) {
            return $true
        }
        $current = $current.InnerException
    }

    return $Exception.Message -match '(?i)timed out|timeout|connection refused|actively refused|network is unreachable|host is unreachable|connection reset|connection aborted|无法连接|连接超时|请求超时|目标计算机积极拒绝'
}

function Register-ControllerTransportFailure {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [Parameter(Mandatory = $true)][Exception]$Exception
    )
    if (-not (Test-ControllerTransportFailure -Exception $Exception)) { return }

    $metrics = Get-AliasMetrics -Alias $Alias
    $metrics.TransportFailureCount++
    $message = [string]$Exception.Message
    if ($message.Length -gt 240) { $message = $message.Substring(0, 240) }
    $script:ControllerTransportFailures[$Alias] = [pscustomobject]@{
        FailedAtUtc = [DateTime]::UtcNow
        Error = $message
    }
}

function Clear-ControllerTransportFailure {
    param([Parameter(Mandatory = $true)][string]$Alias)
    if ($script:ControllerTransportFailures.ContainsKey($Alias)) {
        $null = $script:ControllerTransportFailures.Remove($Alias)
    }
}

function Assert-ControllerCircuitClosed {
    param([Parameter(Mandatory = $true)][string]$Alias)
    if (-not $script:ControllerTransportFailures.ContainsKey($Alias)) { return }

    $failure = $script:ControllerTransportFailures[$Alias]
    $elapsedMs = [long]([DateTime]::UtcNow - [DateTime]$failure.FailedAtUtc).TotalMilliseconds
    $retryAfterMs = [Math]::Max(0, $script:OfflineCooldownMs - $elapsedMs)
    if ($retryAfterMs -le 0) {
        $null = $script:ControllerTransportFailures.Remove($Alias)
        return
    }

    (Get-AliasMetrics -Alias $Alias).CircuitFastFailCount++
    throw "ControllerUnavailableCached: alias=$Alias retryAfterMs=$retryAfterMs lastError=$($failure.Error)"
}

function New-ControllerBinding {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [switch]$BypassCircuit
    )
    if (-not $BypassCircuit) { Assert-ControllerCircuitClosed -Alias $Alias }
    $config = Get-ControllerConfig -Alias $Alias
    $credentialPath = Resolve-RegistryPathValue ([string]$config.credentialFile)
    if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        throw "DPAPI credential file missing: $credentialPath. Run provision-credential.ps1 first."
    }
    $credential = Import-Clixml -LiteralPath $credentialPath
    if ($credential -isnot [System.Management.Automation.PSCredential]) {
        throw "Credential file is not a PSCredential: $credentialPath"
    }
    $metrics = Get-AliasMetrics -Alias $Alias
    $password = $credential.GetNetworkCredential().Password
    $session = New-AbbRwsSession `
        -BaseUrl ([string]$config.baseUrl) `
        -Username ([string]$config.username) `
        -Password $password `
        -RequestTimeoutSeconds (Get-ConfigTimeoutSeconds -Config $config -Kind request)
    $metrics.SessionCreateCount++
    try {
        $identity = Get-IdentityFromSession -Session $session -Metrics $metrics
        Assert-ExpectedIdentity -Identity $identity -Config $config
        $binding = [pscustomobject]@{
            Alias = $Alias
            Config = $config
            Session = $session
            Identity = $identity
            BoundAt = (Get-Date).ToString('o')
            VerifiedAt = (Get-Date).ToString('o')
            LastUsedAtUtc = [DateTime]::UtcNow
        }
        $script:Bindings[$Alias] = $binding
        Clear-ControllerTransportFailure -Alias $Alias
        return $binding
    }
    catch {
        Register-ControllerTransportFailure -Alias $Alias -Exception $_.Exception
        Close-AbbRwsSession -Session $session
        throw
    }
    finally {
        $password = $null
        $credential = $null
    }
}

function Close-ControllerBinding {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [switch]$SkipLogout
    )
    if ($script:Bindings.ContainsKey($Alias)) {
        $binding = $script:Bindings[$Alias]
        if ($null -ne $binding.Session) {
            # ABB RWS has a low per-IP session limit. Explicit logout releases the
            # ABBCX server session instead of waiting for its idle timeout.
            if (-not $SkipLogout) {
                try {
                    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, [uri]($binding.Session.BaseUrl + '/logout'))
                    $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(1))
                    try {
                        $response = $binding.Session.Client.Send($request, $cancel.Token)
                        $response.Dispose()
                    }
                    finally {
                        $cancel.Dispose()
                        $request.Dispose()
                    }
                } catch {}
            }
            Close-AbbRwsSession -Session $binding.Session
        }
        $script:Bindings.Remove($Alias)
        $script:ConfigListCache.Clear()
    }
}

function Update-RegistryIfChanged {
    $item = Get-Item -LiteralPath $script:RegistryPath
    $stamp = "$($item.LastWriteTimeUtc.Ticks):$($item.Length)"
    if ($stamp -eq $script:RegistryStamp) { return $false }

    $updated = Get-Content -LiteralPath $script:RegistryPath -Raw | ConvertFrom-Json
    foreach ($alias in @($script:Bindings.Keys)) {
        $newProperty = $updated.controllers.PSObject.Properties[[string]$alias]
        if ($null -eq $newProperty -or
            (Get-ControllerConfigSignature -Config $script:Bindings[$alias].Config) -ne
            (Get-ControllerConfigSignature -Config $newProperty.Value)) {
            Close-ControllerBinding -Alias ([string]$alias)
        }
    }
    $script:Registry = $updated
    $script:RegistryStamp = $stamp
    $script:ConfigListCache.Clear()
    $script:ControllerTransportFailures.Clear()
    return $true
}

function Get-ControllerBinding {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [switch]$BypassCircuit
    )
    if (-not $BypassCircuit) { Assert-ControllerCircuitClosed -Alias $Alias }
    if (-not $script:Bindings.ContainsKey($Alias)) {
        return New-ControllerBinding -Alias $Alias -BypassCircuit:$BypassCircuit
    }
    return $script:Bindings[$Alias]
}

function Reconnect-ControllerBinding {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [switch]$SkipLogout
    )
    $metrics = Get-AliasMetrics -Alias $Alias
    if ($script:Bindings.ContainsKey($Alias)) { $metrics.ReconnectCount++ }
    Close-ControllerBinding -Alias $Alias -SkipLogout:$SkipLogout
    return New-ControllerBinding -Alias $Alias -BypassCircuit
}

function Invoke-BindingRequest {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][ValidateSet('GET','POST','PUT','DELETE')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Form,
        [byte[]]$Bytes,
        [string]$ContentType = 'application/x-www-form-urlencoded',
        [ValidateRange(0, 1800)][int]$TimeoutSeconds = 0,
        [switch]$NoReconnect
    )
    # The worker handles requests serially, so this timestamp can be used by a
    # later idle-cleanup request without racing an in-flight controller call.
    $Binding.LastUsedAtUtc = [DateTime]::UtcNow
    $metrics = Get-AliasMetrics -Alias $Binding.Alias
    $effectiveTimeout = if ($TimeoutSeconds -gt 0) {
        $TimeoutSeconds
    } else {
        Get-ConfigTimeoutSeconds -Config $Binding.Config -Kind request
    }
    try {
        $response = Invoke-AbbRwsRequest -Session $Binding.Session -Method $Method -Path $Path -Form $Form -Bytes $Bytes -ContentType $ContentType -TimeoutSeconds $effectiveTimeout
        $metrics.RequestCount++
        Clear-ControllerTransportFailure -Alias $Binding.Alias
        if ($response.StatusCode -ne 401 -or $NoReconnect) { return $response }
    }
    catch {
        if ($_.Exception.Message -match '(?i)timed out|timeout') { $metrics.TimeoutCount++ }
        Register-ControllerTransportFailure -Alias $Binding.Alias -Exception $_.Exception
        # Transport failures, DNS errors, and timeouts are not session expiry.
        # Retrying them used to double the wait for an offline new controller.
        throw
    }

    # A final HTTP 401 can indicate an expired ABB cookie/session. Reconnect once;
    # all other explicit HTTP errors are returned to the caller without retries.
    $rebound = Reconnect-ControllerBinding -Alias $Binding.Alias -SkipLogout
    # Keep the caller's binding object live. Without this copy, callers continue
    # holding the disposed pre-reconnect session and repeatedly reconnect.
    $Binding.Config = $rebound.Config
    $Binding.Session = $rebound.Session
    $Binding.Identity = $rebound.Identity
    $Binding.BoundAt = $rebound.BoundAt
    $Binding.VerifiedAt = $rebound.VerifiedAt
    $Binding.LastUsedAtUtc = $rebound.LastUsedAtUtc
    $script:Bindings[$Binding.Alias] = $Binding
    try {
        $response = Invoke-AbbRwsRequest -Session $Binding.Session -Method $Method -Path $Path -Form $Form -Bytes $Bytes -ContentType $ContentType -TimeoutSeconds $effectiveTimeout
        $metrics.RequestCount++
        Clear-ControllerTransportFailure -Alias $Binding.Alias
        return $response
    }
    catch {
        if ($_.Exception.Message -match '(?i)timed out|timeout') { $metrics.TimeoutCount++ }
        Register-ControllerTransportFailure -Alias $Binding.Alias -Exception $_.Exception
        throw
    }
}

function Get-ControllerState {
    param([Parameter(Mandatory = $true)][object]$Binding)
    $opmode = Invoke-BindingRequest -Binding $Binding -Method GET -Path '/rw/panel/opmode?json=1'
    $ctrl = Invoke-BindingRequest -Binding $Binding -Method GET -Path '/rw/panel/ctrlstate?json=1'
    $rapid = Invoke-BindingRequest -Binding $Binding -Method GET -Path '/rw/rapid/execution?json=1'
    Assert-HttpStatus -Response $opmode -Allowed @(200) -Operation 'Read operation mode'
    Assert-HttpStatus -Response $ctrl -Allowed @(200) -Operation 'Read controller state'
    Assert-HttpStatus -Response $rapid -Allowed @(200) -Operation 'Read RAPID state'
    return [pscustomobject]@{
        Opmode = [string](($opmode.Body | ConvertFrom-Json)._embedded._state | Select-Object -First 1).opmode
        ControllerState = [string](($ctrl.Body | ConvertFrom-Json)._embedded._state | Select-Object -First 1).ctrlstate
        RapidState = [string](($rapid.Body | ConvertFrom-Json)._embedded._state | Select-Object -First 1).ctrlexecstate
    }
}

function Assert-SafeStoppedState {
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [string[]]$AllowedControllerStates = @('guardstop','motoroff')
    )
    if ($State.RapidState -ne 'stopped' -or $State.ControllerState -notin $AllowedControllerStates) {
        throw "Unsafe controller state: opmode=$($State.Opmode), ctrl=$($State.ControllerState), rapid=$($State.RapidState)"
    }
}

function Get-RapidModules {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$Task
    )
    $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/rapid/modules?task=$([uri]::EscapeDataString($Task))&json=1"
    Assert-HttpStatus -Response $response -Allowed @(200) -Operation "List RAPID modules for $Task"
    $items = @(($response.Body | ConvertFrom-Json)._embedded._state)
    return @($items | ForEach-Object {
        [pscustomobject]@{
            Name = [string]$_.name
            Type = [string]$_.type
            Task = $Task
        }
    })
}

function Get-RapidModuleText {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$Task,
        [Parameter(Mandatory = $true)][string]$Module,
        [switch]$AllowMissing
    )
    if ($AllowMissing) {
        $exists = @(
            Get-RapidModules -Binding $Binding -Task $Task |
                Where-Object { [string]$_.Name -eq $Module }
        ).Count -gt 0
        if (-not $exists) { return $null }
    }
    $encodedModule = [uri]::EscapeDataString($Module)
    $encodedTask = [uri]::EscapeDataString($Task)
    $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/rapid/modules/$encodedModule`?task=$encodedTask&startrow=1&startcol=1&endrow=10000&endcol=-1"
    Assert-HttpStatus -Response $response -Allowed @(200) -Operation "Read RAPID module $Task/$Module"
    $match = [regex]::Match([string]$response.Body, '<span class="text">(.*?)</span>', 'Singleline')
    if (-not $match.Success) { throw "No module text returned for $Task/$Module" }
    return [Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
}

function Get-RapidDataValue {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$Task,
        [Parameter(Mandatory = $true)][string]$Module,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $encodedTask = [uri]::EscapeDataString($Task)
    $encodedModule = [uri]::EscapeDataString($Module)
    $encodedName = [uri]::EscapeDataString($Name)
    $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/rapid/symbol/data/RAPID/$encodedTask/$encodedModule/$encodedName`?json=1"
    Assert-HttpStatus -Response $response -Allowed @(200) -Operation "Read RAPID data $Task/$Module/$Name"
    $data = @(($response.Body | ConvertFrom-Json)._embedded._state) | Where-Object { $_._type -eq 'rap-data' } | Select-Object -First 1
    if ($null -eq $data) { throw "RAPID data payload missing for $Task/$Module/$Name" }
    return [string]$data.value
}

function Convert-InstanceAttributes {
    param([Parameter(Mandatory = $true)][object]$Instance)
    $values = [ordered]@{}
    foreach ($attribute in @($Instance.attrib)) {
        $values[[string]$attribute._title] = [string]$attribute.value
    }
    return [pscustomobject]$values
}

function Get-ConfigInstance {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [string]$Domain = 'eio',
        [Parameter(Mandatory = $true)][string]$Type,
        [Parameter(Mandatory = $true)][string]$Instance,
        [switch]$AllowMissing
    )
    $Domain = Normalize-ConfigDomain -Domain $Domain
    Assert-SafeIdentifier -Value $Type -Label 'configuration type'
    Assert-SafeConfigInstanceKey -Value $Instance -Label 'configuration instance key'
    if ($AllowMissing) {
        $cacheKey = "$($Binding.Alias)|$($Binding.BoundAt)|$Domain|$Type"
        if (-not $script:ConfigListCache.ContainsKey($cacheKey)) {
            $script:ConfigListCache[$cacheKey] = @(Get-ConfigInstances -Binding $Binding -Domain $Domain -Type $Type)
        }
        $listed = @($script:ConfigListCache[$cacheKey] | Where-Object {
            [string]$_.Key -eq $Instance -or
            (-not [string]::IsNullOrWhiteSpace([string]$_.InstanceId) -and [string]$_.InstanceId -eq $Instance)
        } | Select-Object -First 1)
        if ($listed.Count -eq 0) { return $null }
        $match = $listed[0]
        return [pscustomobject]@{
            Domain = $Domain; Type = $Type; Instance = $Instance
            Key = [string]$match.Key; InstanceId = [string]$match.InstanceId
            DeleteKey = [string]$match.DeleteKey; ReadOnly = [bool]$match.ReadOnly
            Attributes = $match.Attributes
        }
    }
    $encodedType = [uri]::EscapeDataString($Type)
    $encodedInstance = [uri]::EscapeDataString($Instance)
    $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/cfg/$Domain/$encodedType/instances/$encodedInstance`?json=1"
    Assert-HttpStatus -Response $response -Allowed @(200) -Operation "Read configuration $Domain/$Type/$Instance"
    $item = @(($response.Body | ConvertFrom-Json)._embedded._state) | Select-Object -First 1
    if ($null -eq $item) { throw "Configuration instance not found: $Domain/$Type/$Instance" }
    return [pscustomobject]@{
        Domain = $Domain
        Type = $Type
        Instance = $Instance
        Key = [string]$item._title
        InstanceId = [string](Get-ObjectProperty -Object $item -Name 'instanceid')
        DeleteKey = if ([string]::IsNullOrWhiteSpace([string](Get-ObjectProperty -Object $item -Name 'instanceid'))) { [string]$item._title } else { [string](Get-ObjectProperty -Object $item -Name 'instanceid') }
        ReadOnly = ([string]$item.rdonly -eq 'true')
        Attributes = Convert-InstanceAttributes -Instance $item
    }
}

function Get-ConfigInstances {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [string]$Domain = 'eio',
        [Parameter(Mandatory = $true)][string]$Type,
        [int]$PageSize = 70
    )
    $Domain = Normalize-ConfigDomain -Domain $Domain
    Assert-SafeIdentifier -Value $Type -Label 'configuration type'
    $all = [System.Collections.Generic.List[object]]::new()
    $encodedType = [uri]::EscapeDataString($Type)
    $start = 0
    while ($true) {
        $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/cfg/$Domain/$encodedType/instances?start=$start&limit=$PageSize&json=1"
        Assert-HttpStatus -Response $response -Allowed @(200) -Operation "List configuration instances $Domain/$Type"
        $json = $response.Body | ConvertFrom-Json
        $states = @($json._embedded._state)
        foreach ($state in $states) {
            $all.Add([pscustomobject]@{
                Key = [string]$state._title
                InstanceId = [string](Get-ObjectProperty -Object $state -Name 'instanceid')
                DeleteKey = if ([string]::IsNullOrWhiteSpace([string](Get-ObjectProperty -Object $state -Name 'instanceid'))) { [string]$state._title } else { [string](Get-ObjectProperty -Object $state -Name 'instanceid') }
                Domain = $Domain
                Type = $Type
                ReadOnly = ([string]$state.rdonly -eq 'true')
                Attributes = Convert-InstanceAttributes -Instance $state
            })
        }
        $hasNext = $null -ne $json._links -and $null -ne $json._links.PSObject.Properties['next']
        if (-not $hasNext -or $states.Count -eq 0) { break }
        $start += $PageSize
        if ($start -gt 5000) { throw "Pagination guard exceeded for $Domain/$Type" }
    }
    return $all.ToArray()
}

function Get-IoSignal {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $network = [uri]::EscapeDataString([string]$Binding.Config.ioNetwork)
    $device = [uri]::EscapeDataString([string]$Binding.Config.ioDevice)
    $signal = [uri]::EscapeDataString($Name)
    $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/iosystem/signals/$network/$device/$signal`?json=1"
    Assert-HttpStatus -Response $response -Allowed @(200) -Operation "Read I/O signal $Name"
    $item = @(($response.Body | ConvertFrom-Json)._embedded._state) | Select-Object -First 1
    $logicalState = [string](Get-ObjectProperty -Object $item -Name 'lstate')
    $simulated = [string](Get-ObjectProperty -Object $item -Name 'simstate')
    if ([string]::IsNullOrWhiteSpace($simulated)) { $simulated = $logicalState }
    return [pscustomobject]@{
        Name = $Name
        Value = [string](Get-ObjectProperty -Object $item -Name 'lvalue')
        LogicalState = $logicalState
        PhysicalState = [string](Get-ObjectProperty -Object $item -Name 'phstate')
        Quality = [string](Get-ObjectProperty -Object $item -Name 'quality')
        Simulated = $simulated
    }
}

function Convert-IoSignalListItem {
    param([Parameter(Mandatory = $true)][object]$Item)
    $name = [string](Get-ObjectProperty -Object $Item -Name 'name')
    $title = [string](Get-ObjectProperty -Object $Item -Name '_title')
    if ([string]::IsNullOrWhiteSpace($name) -and $title.Contains('/')) {
        $name = @($title -split '/')[-1]
    }
    $logicalState = [string](Get-ObjectProperty -Object $Item -Name 'lstate')
    $simulated = [string](Get-ObjectProperty -Object $Item -Name 'simstate')
    if ([string]::IsNullOrWhiteSpace($simulated)) { $simulated = $logicalState }
    return [pscustomobject]@{
        Name = $name
        Value = [string](Get-ObjectProperty -Object $Item -Name 'lvalue')
        LogicalState = $logicalState
        PhysicalState = [string](Get-ObjectProperty -Object $Item -Name 'phstate')
        Quality = [string](Get-ObjectProperty -Object $Item -Name 'quality')
        Simulated = $simulated
    }
}

function Get-IoSignalsBulk {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [int]$PageSize = 500
    )
    if ($Names.Count -eq 1) { return @(Get-IoSignal -Binding $Binding -Name $Names[0]) }

    $wanted = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $Names) { $null = $wanted.Add([string]$name) }
    $found = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $network = [string]$Binding.Config.ioNetwork
    $device = [string]$Binding.Config.ioDevice
    $start = 0
    while ($found.Count -lt $wanted.Count) {
        $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/iosystem/signals?start=$start&limit=$PageSize&json=1"
        Assert-HttpStatus -Response $response -Allowed @(200) -Operation 'Bulk-read I/O signals'
        $json = $response.Body | ConvertFrom-Json
        $states = @($json._embedded._state)
        foreach ($state in $states) {
            $name = [string](Get-ObjectProperty -Object $state -Name 'name')
            $title = [string](Get-ObjectProperty -Object $state -Name '_title')
            if ([string]::IsNullOrWhiteSpace($name) -and $title.Contains('/')) {
                $name = @($title -split '/')[-1]
            }
            if (-not $wanted.Contains($name)) { continue }
            if (-not [string]::IsNullOrWhiteSpace($title) -and $title.Contains('/')) {
                $parts = @($title -split '/')
                if ($parts.Count -ge 3 -and
                    ($parts[0] -ne $network -or $parts[1] -ne $device)) { continue }
            }
            $found[$name] = Convert-IoSignalListItem -Item $state
        }
        $hasNext = $null -ne $json._links -and $null -ne $json._links.PSObject.Properties['next']
        if (-not $hasNext -or $states.Count -eq 0) { break }
        $start += $PageSize
        if ($start -gt 20000) { throw 'I/O signal pagination guard exceeded.' }
    }

    $missing = @($Names | Where-Object { -not $found.ContainsKey([string]$_) } | Select-Object -Unique)
    if ($missing.Count -gt 0) {
        throw "I/O signals not found on $network/${device}: $($missing -join ', ')"
    }
    return @($Names | ForEach-Object { $found[[string]$_] })
}

function Get-BuildErrorCount {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$Task
    )
    $encodedTask = [uri]::EscapeDataString($Task)
    $start = 1
    $total = 0
    while ($true) {
        $response = Invoke-BindingRequest -Binding $Binding -Method GET -Path "/rw/rapid/tasks/$encodedTask/program/builderror?start=$start&limit=30"
        Assert-HttpStatus -Response $response -Allowed @(200) -Operation "Read build errors for $Task"
        $body = [string]$response.Body
        $count = [regex]::Matches($body, '<li\s+class="[^"]*rap-builderrs[^"]*"', 'IgnoreCase').Count
        $total += $count
        if ($body -notmatch '<a\s+[^>]*rel="next"' -or $count -eq 0) { break }
        $start += $count
        if ($start -gt 10000) { throw "Build-error pagination guard exceeded for $Task" }
    }
    return $total
}

function Get-ControllerSnapshot {
    param([Parameter(Mandatory = $true)][string]$Alias)
    $started = [Diagnostics.Stopwatch]::StartNew()
    $metricsBefore = Copy-AliasMetrics -Alias $Alias
    $binding = Get-ControllerBinding -Alias $Alias
    $identityRead = Get-BindingIdentityForRead -Binding $binding -MaxAgeSeconds 5
    $identity = $identityRead.Identity
    $state = Get-ControllerState -Binding $binding
    $modules = @(Get-RapidModules -Binding $binding -Task ([string]$binding.Config.defaultTask))
    $network = Get-ConfigInstance -Binding $binding -Domain eio -Type 'INDUSTRIAL_NETWORK' -Instance ([string]$binding.Config.ioNetwork)
    $started.Stop()
    return [pscustomobject]@{
        Alias = $Alias
        Endpoint = [string]$binding.Config.baseUrl
        Identity = $identity
        IdentityCacheHit = [bool]$identityRead.CacheHit
        IdentityAgeMs = [long]$identityRead.AgeMs
        State = $state
        RapidModules = $modules
        IndustrialNetwork = $network.Attributes
        Session = [pscustomobject]@{
            BoundAt = $binding.BoundAt
            Metrics = Copy-AliasMetrics -Alias $Alias
            RequestDelta = (Get-AliasMetrics -Alias $Alias).RequestCount - $metricsBefore.RequestCount
            ReconnectDelta = (Get-AliasMetrics -Alias $Alias).ReconnectCount - $metricsBefore.ReconnectCount
        }
        ElapsedMs = $started.ElapsedMilliseconds
    }
}

function Assert-ManifestIdentity {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][object]$Config
    )
    $expected = Get-ObjectProperty -Object $Manifest -Name 'expectedController' -Required
    if ([string]$expected.name -ne [string]$Config.expectedName -or
        (Normalize-SystemId ([string]$expected.systemId)) -ne (Normalize-SystemId ([string]$Config.expectedSystemId)) -or
        [string]$expected.robotWare -ne [string]$Config.expectedRobotWare) {
        throw 'Manifest expectedController does not exactly match the registered controller identity lock.'
    }
}

function Assert-SafeIdentifier {
    param([Parameter(Mandatory = $true)][string]$Value,[Parameter(Mandatory = $true)][string]$Label)
    if ($Value -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') { throw "Unsafe ${Label}: $Value" }
}

function Assert-SafeConfigInstanceKey {
    param([Parameter(Mandatory = $true)][string]$Value,[Parameter(Mandatory = $true)][string]$Label)
    # ABB instance keys commonly contain spaces (for example "PROFINET Network").
    # The value is still URI-escaped before use; reject separators, query markers,
    # controls, and leading/trailing whitespace so it cannot alter an RWS path.
    if ($Value.Length -lt 1 -or $Value.Length -gt 160 -or
        $Value -ne $Value.Trim() -or $Value -match '[\x00-\x1f\x7f/\\?#]') {
        throw "Unsafe ${Label}: $Value"
    }
}

function Get-AllowedConfigDomains {
    $configured = Get-ObjectProperty -Object $script:Registry -Name 'allowedConfigDomains'
    if ($null -eq $configured -or @($configured).Count -eq 0) {
        throw 'controller-registry.json must explicitly define allowedConfigDomains.'
    }
    $domains = @($configured | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
    if (@($domains | Where-Object { $_ -notin $script:BuiltInSafeConfigDomains }).Count -gt 0) {
        throw 'allowedConfigDomains may contain only eio, sio, sys, and proc. Motion configuration is intentionally blocked.'
    }
    return $domains
}

function Normalize-ConfigDomain {
    param([Parameter(Mandatory = $true)][string]$Domain)
    $normalized = $Domain.Trim().ToLowerInvariant()
    if ($normalized -notin (Get-AllowedConfigDomains)) {
        throw "Configuration domain is not allowed by the registry: $Domain"
    }
    return $normalized
}

function Get-CfgFileDomain {
    param([Parameter(Mandatory = $true)][string]$Path)
    return Get-CfgTextDomain -Text ([IO.File]::ReadAllText($Path))
}

function Get-CfgTextDomain {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $firstLine = @($Text -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)[0]
    $match = [regex]::Match([string]$firstLine, '^\s*([A-Za-z][A-Za-z0-9_]*)\s*:CFG_', 'IgnoreCase')
    if (-not $match.Success) { throw 'ABB CFG header is missing or invalid.' }
    return Normalize-ConfigDomain -Domain $match.Groups[1].Value
}

function ConvertFrom-AbbCfgEntryLine {
    param(
        [Parameter(Mandatory = $true)][string]$Domain,
        [Parameter(Mandatory = $true)][string]$Type,
        [Parameter(Mandatory = $true)][string]$Line
    )
    $fields = [ordered]@{}
    $pattern = '-(?<name>[A-Za-z0-9_]+)\s+(?:"(?<quoted>[^"]*)"|(?<bare>[^\s]+))'
    foreach ($match in [regex]::Matches($Line, $pattern)) {
        $value = if ($match.Groups['quoted'].Success) { $match.Groups['quoted'].Value } else { $match.Groups['bare'].Value }
        $fields[$match.Groups['name'].Value] = $value
    }
    if ($fields.Count -eq 0) { throw "Unable to parse ABB CFG entry in $Domain/${Type}: $Line" }
    return [pscustomobject]@{ Domain = $Domain; Type = $Type; Fields = [pscustomobject]$fields }
}

function ConvertFrom-AbbCfgText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $domain = Get-CfgTextDomain -Text $Text
    $entries = [System.Collections.Generic.List[object]]::new()
    $section = ''
    $buffer = ''
    foreach ($rawLine in @($Text -split '\r?\n')) {
        $trimmed = $rawLine.Trim()
        if ($trimmed -match '^[A-Za-z][A-Za-z0-9_]*\s*:CFG_') { continue }
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed -eq '#') {
            if (-not [string]::IsNullOrWhiteSpace($buffer)) {
                $entries.Add((ConvertFrom-AbbCfgEntryLine -Domain $domain -Type $section -Line $buffer))
                $buffer = ''
            }
            continue
        }
        $sectionMatch = [regex]::Match($trimmed, '^([A-Za-z0-9_]+):$')
        if ($sectionMatch.Success) {
            if (-not [string]::IsNullOrWhiteSpace($buffer)) {
                $entries.Add((ConvertFrom-AbbCfgEntryLine -Domain $domain -Type $section -Line $buffer))
                $buffer = ''
            }
            $section = $sectionMatch.Groups[1].Value
            Assert-SafeIdentifier -Value $section -Label 'CFG section type'
            continue
        }
        if ([string]::IsNullOrWhiteSpace($section)) { throw "CFG entry appears before a section: $trimmed" }
        $continued = $trimmed.EndsWith('\')
        $part = if ($continued) { $trimmed.Substring(0, $trimmed.Length - 1).TrimEnd() } else { $trimmed }
        $buffer = ($buffer + ' ' + $part).Trim()
        if (-not $continued) {
            $entries.Add((ConvertFrom-AbbCfgEntryLine -Domain $domain -Type $section -Line $buffer))
            $buffer = ''
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($buffer)) {
        $entries.Add((ConvertFrom-AbbCfgEntryLine -Domain $domain -Type $section -Line $buffer))
    }
    if ($entries.Count -eq 0) { throw 'ABB CFG file contains no configuration entries.' }
    return $entries.ToArray()
}

function Test-CfgEntryPresent {
    param(
        [Parameter(Mandatory = $true)][object]$Entry,
        [Parameter(Mandatory = $true)][object[]]$Instances
    )
    foreach ($instance in @($Instances)) {
        $matches = $true
        foreach ($field in $Entry.Fields.PSObject.Properties) {
            $actualProperty = $instance.Attributes.PSObject.Properties[$field.Name]
            if ($null -eq $actualProperty -or [string]$actualProperty.Value -ne [string]$field.Value) {
                $matches = $false
                break
            }
        }
        if ($matches) { return $true }
    }
    return $false
}

function Get-ConfigInventorySha256 {
    param([Parameter(Mandatory = $true)][object[]]$Instances)
    $rows = @($Instances | ForEach-Object {
        [pscustomobject]@{
            Key = [string]$_.Key
            InstanceId = [string]$_.InstanceId
            AttributesSha256 = Get-ConfigAttributesSha256 -Attributes $_.Attributes
        }
    } | Sort-Object Key,InstanceId)
    return Get-Sha256Text -Text ($rows | ConvertTo-Json -Depth 8 -Compress)
}

function Get-PublicPreparedOperation {
    param([Parameter(Mandatory = $true)][object]$Operation)
    $public = [ordered]@{}
    foreach ($property in $Operation.PSObject.Properties) {
        if ($property.Name -notin @('ArtifactBytes','ParsedEntries')) { $public[$property.Name] = $property.Value }
    }
    return [pscustomobject]$public
}

function Get-ConfigAttributesSha256 {
    param([Parameter(Mandatory = $true)][object]$Attributes)
    $ordered = [ordered]@{}
    foreach ($property in @($Attributes.PSObject.Properties | Sort-Object Name)) {
        $ordered[[string]$property.Name] = [string]$property.Value
    }
    return Get-Sha256Text -Text ($ordered | ConvertTo-Json -Compress)
}

function Assert-CfgVerificationSpec {
    param(
        [Parameter(Mandatory = $true)][object]$Verify,
        [Parameter(Mandatory = $true)][string]$OperationDomain
    )
    $checkCount = 0
    $cfgInstances = Get-ObjectProperty -Object $Verify -Name 'cfgInstances'
    foreach ($item in @($cfgInstances)) {
        if ($null -eq $item) { continue }
        $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $item -Name 'domain' -Required))
        if ($domain -ne $OperationDomain) { throw 'cfg_file_load cfgInstances verification cannot reference another configuration domain.' }
        $type = [string](Get-ObjectProperty -Object $item -Name 'type' -Required)
        $instance = [string](Get-ObjectProperty -Object $item -Name 'instance' -Required)
        Assert-SafeIdentifier -Value $type -Label 'verification configuration type'
        Assert-SafeConfigInstanceKey -Value $instance -Label 'verification configuration instance'
        $fields = Get-ObjectProperty -Object $item -Name 'fields' -Required
        if (@($fields.PSObject.Properties).Count -eq 0) { throw 'cfgInstances verification fields cannot be empty.' }
        foreach ($field in $fields.PSObject.Properties) { Assert-SafeIdentifier -Value ([string]$field.Name) -Label 'verification configuration field' }
        $checkCount++
    }

    $configSignals = Get-ObjectProperty -Object $Verify -Name 'configSignals'
    if ($null -ne $configSignals -and $OperationDomain -ne 'eio') {
        throw 'configSignals verification is valid only for the eio domain.'
    }
    foreach ($signal in @($configSignals)) {
        if ($null -eq $signal) { continue }
        Assert-SafeConfigInstanceKey -Value ([string](Get-ObjectProperty -Object $signal -Name 'name' -Required)) -Label 'configuration signal name'
        $fields = Get-ObjectProperty -Object $signal -Name 'fields'
        if ($null -ne $fields) {
            foreach ($field in $fields.PSObject.Properties) { Assert-SafeIdentifier -Value ([string]$field.Name) -Label 'configuration signal field' }
        }
        $checkCount++
    }

    foreach ($signalName in @((Get-ObjectProperty -Object $Verify -Name 'signals'))) {
        if ($null -eq $signalName) { continue }
        Assert-SafeConfigInstanceKey -Value ([string]$signalName) -Label 'runtime signal name'
        $checkCount++
    }
    if ($checkCount -eq 0) { throw 'cfg_file_load verify must contain at least one cfgInstances, configSignals, or signals check.' }
}

function New-PreparedOperation {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][object]$Operation,
        [Parameter(Mandatory = $true)][object]$Safety
    )
    $kind = ([string](Get-ObjectProperty -Object $Operation -Name 'kind' -Required)).Trim().ToLowerInvariant()
    if ($kind -eq 'rapid_module_replace') { $kind = 'rapid_module_put' }
    switch ($kind) {
        'cfg_set' {
            $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $Operation -Name 'domain' -Required))
            $type = [string](Get-ObjectProperty -Object $Operation -Name 'type' -Required)
            $instance = [string](Get-ObjectProperty -Object $Operation -Name 'instance' -Required)
            Assert-SafeIdentifier -Value $type -Label 'configuration type'
            Assert-SafeConfigInstanceKey -Value $instance -Label 'configuration instance'
            $fields = Get-ObjectProperty -Object $Operation -Name 'fields' -Required
            if (@($fields.PSObject.Properties).Count -eq 0) { throw 'cfg_set fields cannot be empty.' }
            $current = Get-ConfigInstance -Binding $Binding -Domain $domain -Type $type -Instance $instance
            if ($current.ReadOnly) { throw "Configuration instance is read-only: $domain/$type/$instance" }
            $before = [ordered]@{}
            $desired = [ordered]@{}
            foreach ($field in $fields.PSObject.Properties) {
                Assert-SafeIdentifier -Value ([string]$field.Name) -Label 'configuration field'
                $before[[string]$field.Name] = [string](Get-ObjectProperty -Object $current.Attributes -Name ([string]$field.Name) -Required)
                $desired[[string]$field.Name] = [string]$field.Value
            }
            $needsChange = $false
            foreach ($name in $desired.Keys) { if ($before[$name] -ne $desired[$name]) { $needsChange = $true } }
            return [pscustomobject]@{
                Kind = $kind; Domain = $domain; Type = $type; Instance = $instance
                Before = [pscustomobject]$before; Desired = [pscustomobject]$desired; NeedsChange = $needsChange
            }
        }
        'cfg_upsert' {
            $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $Operation -Name 'domain' -Required))
            $type = [string](Get-ObjectProperty -Object $Operation -Name 'type' -Required)
            $instance = [string](Get-ObjectProperty -Object $Operation -Name 'instance' -Required)
            Assert-SafeIdentifier -Value $type -Label 'configuration type'
            Assert-SafeConfigInstanceKey -Value $instance -Label 'configuration instance'
            $fields = Get-ObjectProperty -Object $Operation -Name 'fields' -Required
            if (@($fields.PSObject.Properties).Count -eq 0) { throw 'cfg_upsert fields cannot be empty.' }
            $current = Get-ConfigInstance -Binding $Binding -Domain $domain -Type $type -Instance $instance -AllowMissing
            if ($null -ne $current -and $current.ReadOnly) { throw "Configuration instance is read-only: $domain/$type/$instance" }
            $before = [ordered]@{}
            $desired = [ordered]@{}
            $needsChange = ($null -eq $current)
            foreach ($field in $fields.PSObject.Properties) {
                Assert-SafeIdentifier -Value ([string]$field.Name) -Label 'configuration field'
                if ($null -ne $current) {
                    $before[[string]$field.Name] = [string](Get-ObjectProperty -Object $current.Attributes -Name ([string]$field.Name) -Required)
                }
                $desired[[string]$field.Name] = [string]$field.Value
                if ($null -ne $current -and $before[[string]$field.Name] -ne [string]$field.Value) { $needsChange = $true }
            }
            return [pscustomobject]@{
                Kind = $kind; Domain = $domain; Type = $type; Instance = $instance
                BeforeExists = ($null -ne $current); Before = [pscustomobject]$before
                Desired = [pscustomobject]$desired; NeedsChange = $needsChange
            }
        }
        'cfg_delete' {
            $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $Operation -Name 'domain' -Required))
            $type = [string](Get-ObjectProperty -Object $Operation -Name 'type' -Required)
            $instanceKey = [string](Get-ObjectProperty -Object $Operation -Name 'instanceKey' -Required)
            Assert-SafeIdentifier -Value $type -Label 'configuration type'
            Assert-SafeConfigInstanceKey -Value $instanceKey -Label 'configuration instance key'
            if ([bool](Get-ObjectProperty -Object $Operation -Name 'ifPresent' -Required) -ne $true) {
                throw 'cfg_delete requires ifPresent=true so reruns remain safe.'
            }
            $current = Get-ConfigInstance -Binding $Binding -Domain $domain -Type $type -Instance $instanceKey -AllowMissing
            if ($null -ne $current -and $current.ReadOnly) { throw "Configuration instance is read-only: $domain/$type/$instanceKey" }
            return [pscustomobject]@{
                Kind = $kind; Domain = $domain; Type = $type; InstanceKey = $instanceKey
                DeleteKey = if ($null -eq $current) { $instanceKey } else { [string]$current.DeleteKey }
                BeforeExists = ($null -ne $current)
                BeforeAttributesSha256 = if ($null -eq $current) { $null } else { Get-ConfigAttributesSha256 -Attributes $current.Attributes }
                Before = if ($null -eq $current) { $null } else { $current.Attributes }
                NeedsChange = ($null -ne $current)
            }
        }
        'rapid_set_init' {
            $task = [string](Get-ObjectProperty -Object $Operation -Name 'task' -Required)
            $module = [string](Get-ObjectProperty -Object $Operation -Name 'module' -Required)
            $name = [string](Get-ObjectProperty -Object $Operation -Name 'name' -Required)
            $value = [string](Get-ObjectProperty -Object $Operation -Name 'value' -Required)
            Assert-SafeIdentifier -Value $task -Label 'RAPID task'
            Assert-SafeIdentifier -Value $module -Label 'RAPID module'
            Assert-SafeIdentifier -Value $name -Label 'RAPID data name'
            $before = Get-RapidDataValue -Binding $Binding -Task $task -Module $module -Name $name
            return [pscustomobject]@{
                Kind = $kind; Task = $task; Module = $module; Name = $name
                Before = $before; Desired = $value; NeedsChange = ($before -ne $value)
            }
        }
        'rapid_module_put' {
            $task = [string](Get-ObjectProperty -Object $Operation -Name 'task' -Required)
            $module = [string](Get-ObjectProperty -Object $Operation -Name 'module' -Required)
            Assert-SafeIdentifier -Value $task -Label 'RAPID task'
            Assert-SafeIdentifier -Value $module -Label 'RAPID module'
            $localPath = Resolve-AllowedLocalFile -Path ([string](Get-ObjectProperty -Object $Operation -Name 'localPath' -Required)) -Extensions @('.mod','.sys')
            $artifactBytes = [IO.File]::ReadAllBytes($localPath)
            $source = Convert-BytesToText -Bytes $artifactBytes
            if ([string]$Binding.Identity.RobotWare -like '6.*' -and $source -match '[^\x00-\x7F]') {
                throw "RW6 RAPID source must be ASCII: $localPath"
            }
            if ($source -notmatch "(?mi)^\s*MODULE\s+$([regex]::Escape($module))(?:\s*\(|\s*$)") {
                throw "RAPID source does not declare MODULE $module"
            }
            $online = Get-RapidModuleText -Binding $Binding -Task $task -Module $module -AllowMissing
            $onlineHash = if ($null -eq $online) { $null } else { Get-Sha256Text -Text $online }
            $localHash = Get-Sha256Text -Text $source
            return [pscustomobject]@{
                Kind = $kind; Task = $task; Module = $module; LocalPath = $localPath
                FileSha256 = Get-Sha256Bytes -Bytes $artifactBytes; SourceSha256 = $localHash
                ArtifactBytes = $artifactBytes
                BeforeSourceSha256 = $onlineHash; BeforeExists = ($null -ne $online)
                NeedsChange = ($onlineHash -ne $localHash)
            }
        }
        'rapid_module_delete' {
            $task = [string](Get-ObjectProperty -Object $Operation -Name 'task' -Required)
            $module = [string](Get-ObjectProperty -Object $Operation -Name 'module' -Required)
            Assert-SafeIdentifier -Value $task -Label 'RAPID task'
            Assert-SafeIdentifier -Value $module -Label 'RAPID module'
            if ([bool](Get-ObjectProperty -Object $Operation -Name 'ifPresent' -Required) -ne $true) {
                throw 'rapid_module_delete requires ifPresent=true so reruns remain safe.'
            }
            $moduleInfo = @(Get-RapidModules -Binding $Binding -Task $task | Where-Object Name -eq $module | Select-Object -First 1)
            $allowSystemModule = [bool](Get-ObjectProperty -Object $Operation -Name 'allowSystemModule')
            if ($moduleInfo.Count -gt 0 -and [string]$moduleInfo[0].Type -match '(?i)sys' -and -not $allowSystemModule) {
                throw "Refusing to delete RAPID system module $task/$module without allowSystemModule=true."
            }
            $online = if ($moduleInfo.Count -eq 0) { $null } else { Get-RapidModuleText -Binding $Binding -Task $task -Module $module }
            return [pscustomobject]@{
                Kind = $kind; Task = $task; Module = $module
                ModuleType = if ($moduleInfo.Count -eq 0) { $null } else { [string]$moduleInfo[0].Type }
                AllowSystemModule = $allowSystemModule
                BeforeExists = ($null -ne $online)
                BeforeSourceSha256 = if ($null -eq $online) { $null } else { Get-Sha256Text -Text $online }
                NeedsChange = ($null -ne $online)
            }
        }
        'cfg_file_load' {
            $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $Operation -Name 'domain' -Required))
            $actionType = [string](Get-ObjectProperty -Object $Operation -Name 'actionType' -Required)
            if ($actionType -notin @('add','add-with-reset')) {
                throw 'cfg_file_load permits only add or add-with-reset; full-domain replace is blocked.'
            }
            $localPath = Resolve-AllowedLocalFile -Path ([string](Get-ObjectProperty -Object $Operation -Name 'localPath' -Required)) -Extensions @('.cfg')
            $artifactBytes = [IO.File]::ReadAllBytes($localPath)
            $cfgText = Convert-BytesToText -Bytes $artifactBytes
            $fileDomain = Get-CfgTextDomain -Text $cfgText
            if ($fileDomain -ne $domain) { throw "CFG header domain '$fileDomain' does not match operation domain '$domain'." }
            $parsedEntries = @(ConvertFrom-AbbCfgText -Text $cfgText)
            $verify = Get-ObjectProperty -Object $Operation -Name 'verify'
            if ($null -eq $verify) { throw 'cfg_file_load requires an operation-level verify block.' }
            Assert-CfgVerificationSpec -Verify $verify -OperationDomain $domain
            $typeSnapshots = [ordered]@{}
            $missingOrChanged = [System.Collections.Generic.List[object]]::new()
            foreach ($type in @($parsedEntries.Type | Sort-Object -Unique)) {
                $instances = @(Get-ConfigInstances -Binding $Binding -Domain $domain -Type ([string]$type))
                $typeSnapshots[[string]$type] = Get-ConfigInventorySha256 -Instances $instances
                foreach ($entry in @($parsedEntries | Where-Object Type -eq $type)) {
                    if (-not (Test-CfgEntryPresent -Entry $entry -Instances $instances)) { $missingOrChanged.Add($entry) }
                }
            }
            return [pscustomobject]@{
                Kind = $kind; Domain = $domain; ActionType = $actionType; LocalPath = $localPath
                FileSha256 = Get-Sha256Bytes -Bytes $artifactBytes; ArtifactBytes = $artifactBytes
                ParsedEntries = $parsedEntries; DesiredEntryCount = $parsedEntries.Count
                MissingOrChangedEntryCount = $missingOrChanged.Count
                MissingOrChangedEntries = $missingOrChanged.ToArray()
                BeforeTypeInventorySha256 = [pscustomobject]$typeSnapshots
                Verify = $verify; NeedsChange = ($missingOrChanged.Count -gt 0)
            }
        }
        default { throw "Unsupported operation kind: $kind" }
    }
}

function Assert-NoOperationConflicts {
    param([Parameter(Mandatory = $true)][object[]]$Operations)
    $targets = @{}
    $cfgFileTypes = @{}
    $cfgInstanceModes = @{}
    foreach ($operation in @($Operations | Where-Object Kind -eq 'cfg_file_load')) {
        foreach ($type in @($operation.ParsedEntries.Type | Sort-Object -Unique)) {
            $key = "$($operation.Domain)|$type".ToLowerInvariant()
            if ($cfgFileTypes.ContainsKey($key)) { throw "Multiple CFG files touch the same configuration type: $key" }
            $cfgFileTypes[$key] = $true
        }
    }
    foreach ($operation in @($Operations)) {
        switch ($operation.Kind) {
            { $_ -in @('cfg_set','cfg_upsert') } {
                $base = "$($operation.Domain)|$($operation.Type)|$($operation.Instance)".ToLowerInvariant()
                if ($cfgInstanceModes.ContainsKey($base) -and ($operation.Kind -eq 'cfg_upsert' -or $cfgInstanceModes[$base] -eq 'cfg_upsert')) {
                    throw "cfg_upsert cannot be combined with another operation on the same instance: $base"
                }
                $cfgInstanceModes[$base] = $operation.Kind
                if ($cfgFileTypes.ContainsKey("$($operation.Domain)|$($operation.Type)".ToLowerInvariant())) {
                    throw "cfg_set conflicts with cfg_file_load for $($operation.Domain)/$($operation.Type)"
                }
                if ($targets.ContainsKey("cfg-delete|$base")) { throw "cfg_set conflicts with cfg_delete for $base" }
                foreach ($field in $operation.Desired.PSObject.Properties) {
                    $key = "cfg-field|$base|$($field.Name)".ToLowerInvariant()
                    if ($targets.ContainsKey($key)) { throw "Duplicate cfg_set target: $key" }
                    $targets[$key] = $true
                }
            }
            'cfg_delete' {
                $base = "$($operation.Domain)|$($operation.Type)|$($operation.InstanceKey)".ToLowerInvariant()
                if ($cfgFileTypes.ContainsKey("$($operation.Domain)|$($operation.Type)".ToLowerInvariant())) {
                    throw "cfg_delete conflicts with cfg_file_load for $($operation.Domain)/$($operation.Type); use a separate exact cleanup changeset."
                }
                if (@($targets.Keys | Where-Object { $_ -like "cfg-field|$base|*" }).Count -gt 0) { throw "cfg_delete conflicts with cfg_set for $base" }
                $key = "cfg-delete|$base"
                if ($targets.ContainsKey($key)) { throw "Duplicate cfg_delete target: $base" }
                $targets[$key] = $true
            }
            'rapid_set_init' {
                $moduleKey = "$($operation.Task)|$($operation.Module)".ToLowerInvariant()
                if ($targets.ContainsKey("rapid-module|$moduleKey")) { throw "rapid_set_init conflicts with a module put/delete for $moduleKey" }
                $key = "rapid-data|$moduleKey|$($operation.Name)".ToLowerInvariant()
                if ($targets.ContainsKey($key)) { throw "Duplicate RAPID data target: $key" }
                $targets[$key] = $true
            }
            { $_ -in @('rapid_module_put','rapid_module_delete') } {
                $moduleKey = "$($operation.Task)|$($operation.Module)".ToLowerInvariant()
                $key = "rapid-module|$moduleKey"
                if ($targets.ContainsKey($key) -or @($targets.Keys | Where-Object { $_ -like "rapid-data|$moduleKey|*" }).Count -gt 0) {
                    throw "Conflicting RAPID module operations for $moduleKey"
                }
                $targets[$key] = $true
            }
        }
    }
}

function Prepare-AbbLoadedManifest {
    param([Parameter(Mandatory = $true)][object]$Loaded)
    $started = [Diagnostics.Stopwatch]::StartNew()
    $loaded = $Loaded
    $manifest = $loaded.Manifest
    $alias = [string](Get-ObjectProperty -Object $manifest -Name 'controller' -Required)
    $metricsBefore = Copy-AliasMetrics -Alias $alias
    $binding = Get-ControllerBinding -Alias $alias -BypassCircuit
    Assert-ManifestIdentity -Manifest $manifest -Config $binding.Config
    # AllowMissing inventory is useful within one plan, but must never survive
    # into a later plan after RobotStudio or the pendant changed configuration.
    $script:ConfigListCache.Clear()

    $identity = Get-BindingIdentity -Binding $binding
    Assert-ExpectedIdentity -Identity $identity -Config $binding.Config
    $state = Get-ControllerState -Binding $binding
    $safety = Get-ObjectProperty -Object $manifest -Name 'safety' -Required
    if ([bool](Get-ObjectProperty -Object $safety -Name 'requireRapidStopped' -Required) -ne $true) {
        throw 'All ABB jobs must require RAPID stopped.'
    }
    $allowedStates = @($safety.allowedControllerStates | ForEach-Object { [string]$_ })
    if ($allowedStates.Count -eq 0 -or @($allowedStates | Where-Object { $_ -notin @('guardstop','motoroff') }).Count -gt 0) {
        throw 'allowedControllerStates may contain only guardstop and motoroff.'
    }
    Assert-SafeStoppedState -State $state -AllowedControllerStates $allowedStates

    $operations = @($manifest.operations)
    if ($operations.Count -eq 0) { throw 'ABB job operations cannot be empty.' }
    if ($operations.Count -gt 250) { throw 'ABB job operations cannot exceed 250; split the work into separately approved batches.' }
    $preparedOperations = @($operations | ForEach-Object { New-PreparedOperation -Binding $binding -Operation $_ -Safety $safety })
    Assert-NoOperationConflicts -Operations $preparedOperations

    $restart = Get-ObjectProperty -Object $manifest -Name 'restart'
    if ($null -ne $restart) {
        if ([string]$restart.mode -ne 'restart') { throw 'Only ordinary restart mode is supported.' }
        if ([int]$restart.timeoutSeconds -lt 30 -or [int]$restart.timeoutSeconds -gt 600) {
            throw 'restart.timeoutSeconds must be between 30 and 600.'
        }
    }
    $changedConfigCount = @($preparedOperations | Where-Object { $_.NeedsChange -and $_.Kind -in @('cfg_set','cfg_upsert','cfg_delete','cfg_file_load') }).Count
    if ($changedConfigCount -gt 0 -and ($null -eq $restart -or [bool]$restart.required -ne $true)) {
        throw 'Configuration changes require one explicit ordinary restart in the same changeset.'
    }

    $token = [guid]::NewGuid().ToString('N')
    $expires = (Get-Date).AddMinutes(10)
    $script:PreparedJobs[$token] = [pscustomobject]@{
        Token = $token
        ManifestPath = $loaded.Path
        ManifestHash = $loaded.Hash
        Manifest = $manifest
        Alias = $alias
        Identity = $identity
        State = $state
        Operations = $preparedOperations
        MetricsAtStart = $metricsBefore
        CreatedAt = Get-Date
        ExpiresAt = $expires
        Used = $false
    }
    $started.Stop()
    return [pscustomobject]@{
        Prepared = $true
        Token = $token
        ExpiresAt = $expires.ToString('o')
        Controller = $alias
        Identity = $identity
        State = $state
        ManifestSha256 = $loaded.Hash
        OperationCount = $preparedOperations.Count
        ChangesRequired = @($preparedOperations | Where-Object NeedsChange).Count
        Operations = @($preparedOperations | ForEach-Object { Get-PublicPreparedOperation -Operation $_ })
        RestartRequired = if ($null -eq $restart) { $false } else { [bool]$restart.required }
        ControllerModified = $false
        Metrics = Copy-AliasMetrics -Alias $alias
        RequestDelta = (Get-AliasMetrics -Alias $alias).RequestCount - $metricsBefore.RequestCount
        SessionCreateDelta = (Get-AliasMetrics -Alias $alias).SessionCreateCount - $metricsBefore.SessionCreateCount
        ReconnectDelta = (Get-AliasMetrics -Alias $alias).ReconnectCount - $metricsBefore.ReconnectCount
        TimeoutDelta = (Get-AliasMetrics -Alias $alias).TimeoutCount - $metricsBefore.TimeoutCount
        ElapsedMs = $started.ElapsedMilliseconds
    }
}

function Prepare-AbbChangeset {
    param([Parameter(Mandatory = $true)][object]$Changeset)
    $json = $Changeset | ConvertTo-Json -Depth 40 -Compress
    $detached = $json | ConvertFrom-Json
    return Prepare-AbbLoadedManifest -Loaded ([pscustomobject]@{
        Path = $null
        Hash = Get-Sha256Text -Text $json
        Manifest = $detached
    })
}

function Assert-PreparedJobUnchanged {
    param([Parameter(Mandatory = $true)][object]$Prepared)
    if ($Prepared.Used) { throw 'Prepared token has already been used.' }
    if ((Get-Date) -gt $Prepared.ExpiresAt) { throw 'Prepared token has expired.' }
    if (-not [string]::IsNullOrWhiteSpace([string]$Prepared.ManifestPath)) {
        if ((Get-Sha256File -Path $Prepared.ManifestPath) -ne $Prepared.ManifestHash) {
            throw 'Manifest changed after prepare; prepare a new job.'
        }
    }
    # Artifact bytes are captured and hashed during prepare, retained only in the
    # in-memory single-use token, and uploaded from that immutable byte array.
}

function Request-Mastership {
    param([Parameter(Mandatory = $true)][object]$Binding)
    $response = Invoke-BindingRequest -Binding $Binding -Method POST -Path '/rw/mastership?action=request' -Form @{ x = '' } -NoReconnect
    Assert-HttpStatus -Response $response -Allowed @(204) -Operation 'Request ABB mastership'
}

function Release-MastershipBestEffort {
    param([Parameter(Mandatory = $true)][object]$Binding)
    try {
        return Invoke-BindingRequest -Binding $Binding -Method POST -Path '/rw/mastership?action=release' -Form @{ x = '' } -NoReconnect
    } catch { return $null }
}

function Assert-OperationPrecondition {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][object]$Operation
    )
    switch ($Operation.Kind) {
        'cfg_set' {
            $current = Get-ConfigInstance -Binding $Binding -Domain $Operation.Domain -Type $Operation.Type -Instance $Operation.Instance
            foreach ($field in $Operation.Before.PSObject.Properties) {
                $actual = [string](Get-ObjectProperty -Object $current.Attributes -Name $field.Name -Required)
                if ($actual -ne [string]$field.Value) {
                    throw "cfg_set precondition changed for $($Operation.Type)/$($Operation.Instance)/$($field.Name): actual=$actual expected=$($field.Value)"
                }
            }
        }
        'cfg_upsert' {
            $current = Get-ConfigInstance -Binding $Binding -Domain $Operation.Domain -Type $Operation.Type -Instance $Operation.Instance -AllowMissing
            $exists = ($null -ne $current)
            if ($exists -ne [bool]$Operation.BeforeExists) {
                throw "cfg_upsert existence precondition changed for $($Operation.Domain)/$($Operation.Type)/$($Operation.Instance)"
            }
            if ($exists) {
                foreach ($field in $Operation.Before.PSObject.Properties) {
                    $actual = [string](Get-ObjectProperty -Object $current.Attributes -Name $field.Name -Required)
                    if ($actual -ne [string]$field.Value) {
                        throw "cfg_upsert precondition changed for $($Operation.Type)/$($Operation.Instance)/$($field.Name)"
                    }
                }
            }
        }
        'cfg_delete' {
            $current = Get-ConfigInstance -Binding $Binding -Domain $Operation.Domain -Type $Operation.Type -Instance $Operation.InstanceKey -AllowMissing
            $exists = ($null -ne $current)
            if ($exists -ne [bool]$Operation.BeforeExists) {
                throw "cfg_delete precondition changed for $($Operation.Domain)/$($Operation.Type)/$($Operation.InstanceKey)"
            }
            if ($exists -and (Get-ConfigAttributesSha256 -Attributes $current.Attributes) -ne $Operation.BeforeAttributesSha256) {
                throw "cfg_delete attributes changed for $($Operation.Domain)/$($Operation.Type)/$($Operation.InstanceKey)"
            }
        }
        'rapid_set_init' {
            $current = Get-RapidDataValue -Binding $Binding -Task $Operation.Task -Module $Operation.Module -Name $Operation.Name
            if ($current -ne $Operation.Before) { throw "RAPID data precondition changed for $($Operation.Module).$($Operation.Name)" }
        }
        'rapid_module_put' {
            $online = Get-RapidModuleText -Binding $Binding -Task $Operation.Task -Module $Operation.Module -AllowMissing
            $hash = if ($null -eq $online) { $null } else { Get-Sha256Text -Text $online }
            if ($hash -ne $Operation.BeforeSourceSha256) { throw "RAPID module precondition changed for $($Operation.Task)/$($Operation.Module)" }
        }
        'rapid_module_delete' {
            $online = Get-RapidModuleText -Binding $Binding -Task $Operation.Task -Module $Operation.Module -AllowMissing
            $hash = if ($null -eq $online) { $null } else { Get-Sha256Text -Text $online }
            if (($null -ne $online) -ne [bool]$Operation.BeforeExists -or $hash -ne $Operation.BeforeSourceSha256) {
                throw "RAPID module delete precondition changed for $($Operation.Task)/$($Operation.Module)"
            }
        }
        'cfg_file_load' {
            foreach ($snapshot in $Operation.BeforeTypeInventorySha256.PSObject.Properties) {
                $instances = @(Get-ConfigInstances -Binding $Binding -Domain $Operation.Domain -Type ([string]$snapshot.Name))
                $actualHash = Get-ConfigInventorySha256 -Instances $instances
                if ($actualHash -ne [string]$snapshot.Value) {
                    throw "CFG file precondition changed for $($Operation.Domain)/$($snapshot.Name)"
                }
            }
        }
    }
}

function New-RemoteStagingDirectory {
    param([Parameter(Mandatory = $true)][object]$Binding,[Parameter(Mandatory = $true)][string]$Name)
    $response = Invoke-BindingRequest -Binding $Binding -Method POST -Path '/fileservice/$HOME/' -Form @{
        'fs-action' = 'create'
        'fs-newname' = $Name
    }
    Assert-HttpStatus -Response $response -Allowed @(200,201,204,409) -Operation 'Create remote staging directory'
}

function Upload-StagedFile {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$RemoteDirectory,
        [Parameter(Mandatory = $true)][string]$LocalPath,
        [Parameter(Mandatory = $true)][byte[]]$ArtifactBytes
    )
    $fileName = [IO.Path]::GetFileName($LocalPath)
    $response = Invoke-BindingRequest -Binding $Binding -Method PUT -Path "/fileservice/`$HOME/$RemoteDirectory/$fileName" -Bytes $ArtifactBytes -ContentType 'text/plain; charset=utf-8' -TimeoutSeconds (Get-ConfigTimeoutSeconds -Config $Binding.Config -Kind long)
    Assert-HttpStatus -Response $response -Allowed @(200,201,204) -Operation "Upload $fileName"
    return [pscustomobject]@{ FileName = $fileName; Http = [int]$response.StatusCode; ControllerPath = "HOME:/$RemoteDirectory/$fileName" }
}

function Remove-RemoteStagingDirectoryBestEffort {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][string]$RemoteDirectory
    )
    if ($RemoteDirectory -notmatch '^codex_mcp_[0-9]{8}_[0-9]{6}_[a-f0-9]{8}$') {
        return [pscustomobject]@{ Removed = $false; Error = 'Refused unsafe staging directory name.' }
    }
    try {
        $response = Invoke-BindingRequest -Binding $Binding -Method DELETE -Path "/fileservice/`$HOME/$RemoteDirectory" -NoReconnect
        if ($response.StatusCode -in @(200,204,404)) {
            return [pscustomobject]@{ Removed = $true; Http = [int]$response.StatusCode; Directory = $RemoteDirectory }
        }
        return [pscustomobject]@{ Removed = $false; Http = [int]$response.StatusCode; Directory = $RemoteDirectory; Error = $response.FlatBody }
    }
    catch {
        return [pscustomobject]@{ Removed = $false; Directory = $RemoteDirectory; Error = $_.Exception.Message }
    }
}

function Get-MetricDeltaResult {
    param(
        [Parameter(Mandatory = $true)][object]$Before,
        [Parameter(Mandatory = $true)][object]$After
    )
    return [pscustomobject]@{
        RequestDelta = [int]$After.RequestCount - [int]$Before.RequestCount
        SessionCreateDelta = [int]$After.SessionCreateCount - [int]$Before.SessionCreateCount
        ReconnectDelta = [int]$After.ReconnectCount - [int]$Before.ReconnectCount
        TimeoutDelta = [int]$After.TimeoutCount - [int]$Before.TimeoutCount
        TransportFailureDelta = [int]$After.TransportFailureCount - [int]$Before.TransportFailureCount
        CircuitFastFailDelta = [int]$After.CircuitFastFailCount - [int]$Before.CircuitFastFailCount
        Totals = $After
    }
}

function Invoke-CfgFileLoad {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][object]$Operation,
        [Parameter(Mandatory = $true)][string]$RemoteDirectory
    )
    $upload = Upload-StagedFile -Binding $Binding -RemoteDirectory $RemoteDirectory -LocalPath $Operation.LocalPath -ArtifactBytes $Operation.ArtifactBytes
    Request-Mastership -Binding $Binding
    try {
        $script:ConfigListCache.Clear()
        Assert-OperationPrecondition -Binding $Binding -Operation $Operation
        $validate = Invoke-BindingRequest -Binding $Binding -Method POST -Path '/rw/cfg?action=validate' -Form @{
            filepath = $upload.ControllerPath
            'action-type' = $Operation.ActionType
        } -TimeoutSeconds (Get-ConfigTimeoutSeconds -Config $Binding.Config -Kind long) -NoReconnect
        Assert-HttpStatus -Response $validate -Allowed @(200,204) -Operation 'Validate ABB configuration file'
        $loadStatus = $null
        $transportUnknown = $false
        $load = $null
        try {
            $load = Invoke-BindingRequest -Binding $Binding -Method POST -Path '/rw/cfg?action=load' -Form @{
                filepath = $upload.ControllerPath
                'action-type' = $Operation.ActionType
            } -TimeoutSeconds (Get-ConfigTimeoutSeconds -Config $Binding.Config -Kind long) -NoReconnect
        }
        catch {
            # RW6 can reset RWS after accepting an EIO load. Independent readback is authoritative.
            $transportUnknown = $true
        }
        if ($null -ne $load) {
            $loadStatus = [int]$load.StatusCode
            Assert-HttpStatus -Response $load -Allowed @(200,204) -Operation 'Load ABB configuration file'
        }
        return [pscustomobject]@{
            Kind = $Operation.Kind; UploadHttp = $upload.Http; ValidateHttp = [int]$validate.StatusCode
            LoadHttp = $loadStatus; TransportUnknown = $transportUnknown
        }
    }
    finally {
        $release = Release-MastershipBestEffort -Binding $Binding
        if ($null -eq $release -or $release.StatusCode -ne 204) {
            # Logout/connection close is the authoritative fallback release for
            # ABB's global mastership if the explicit release response is lost.
            Close-ControllerBinding -Alias $Binding.Alias
        }
    }
}

function Invoke-OrdinaryRestartAndWait {
    param(
        [Parameter(Mandatory = $true)][string]$Alias,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $binding = Get-ControllerBinding -Alias $Alias -BypassCircuit
    $requestAccepted = $false
    $requestTransportUnknown = $false
    $response = $null
    try {
        $restartRequestTimeout = [Math]::Min(15, (Get-ConfigTimeoutSeconds -Config $binding.Config -Kind long))
        $response = Invoke-BindingRequest -Binding $binding -Method POST -Path '/rw/panel?action=restart' -Form @{ 'restart-mode' = 'restart' } -TimeoutSeconds $restartRequestTimeout -NoReconnect
    }
    catch {
        # Only a missing HTTP response is transport-unknown. Explicit 400/403/500
        # responses are returned normally by the helper and are rejected below.
        $requestTransportUnknown = $true
    }
    if ($null -ne $response) {
        Assert-HttpStatus -Response $response -Allowed @(200,202,204) -Operation 'Restart controller'
        $requestAccepted = $true
    }
    Close-ControllerBinding -Alias $Alias

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $acceptedAtUtc = [DateTime]::UtcNow
    $lastError = ''
    $online = $false
    $offlineObserved = $false
    $consecutiveOnlineChecks = 0
    while ((Get-Date) -lt $deadline -and -not $online) {
        Start-Sleep -Seconds 2
        try {
            $null = New-ControllerBinding -Alias $Alias -BypassCircuit
            if ($offlineObserved) {
                $online = $true
            } elseif (
                $requestAccepted -and
                ([DateTime]::UtcNow - $acceptedAtUtc).TotalSeconds -ge 4
            ) {
                # A fast controller restart can complete between two-second
                # samples, so an offline transition is not guaranteed to be
                # observable. After an explicit 2xx acknowledgement and a
                # minimum settle interval, require two independent fresh
                # sessions before declaring the controller back online.
                $consecutiveOnlineChecks++
                if ($consecutiveOnlineChecks -ge 2) {
                    $online = $true
                } else {
                    Close-ControllerBinding -Alias $Alias
                    $lastError = 'Restart acknowledged; waiting for a second fresh online check.'
                }
            } else {
                # A successful connection before any offline transition can be the
                # old controller session while shutdown is still pending.
                Close-ControllerBinding -Alias $Alias
                $lastError = 'Restart acknowledged, but controller offline transition has not yet been observed.'
            }
        }
        catch {
            $offlineObserved = $true
            $consecutiveOnlineChecks = 0
            $lastError = $_.Exception.Message
            Close-ControllerBinding -Alias $Alias
        }
    }
    if (-not $online) { throw "Controller did not return after restart within $TimeoutSeconds seconds: $lastError" }
    return [pscustomobject]@{
        Requested = $requestAccepted
        RequestTransportUnknown = $requestTransportUnknown
        OfflineObserved = $offlineObserved
        ConsecutiveOnlineChecks = $consecutiveOnlineChecks
        Online = $true
        TimeoutSeconds = $TimeoutSeconds
    }
}

function Test-OperationVerification {
    param(
        [Parameter(Mandatory = $true)][object]$Binding,
        [Parameter(Mandatory = $true)][object]$Operation
    )
    switch ($Operation.Kind) {
        'cfg_set' {
            $current = Get-ConfigInstance -Binding $Binding -Domain $Operation.Domain -Type $Operation.Type -Instance $Operation.Instance
            $mismatches = @()
            foreach ($field in $Operation.Desired.PSObject.Properties) {
                $actual = [string](Get-ObjectProperty -Object $current.Attributes -Name $field.Name -Required)
                if ($actual -ne [string]$field.Value) { $mismatches += "$($field.Name):$actual!=$($field.Value)" }
            }
            return [pscustomobject]@{ Kind = $Operation.Kind; Target = "$($Operation.Domain)/$($Operation.Type)/$($Operation.Instance)"; Passed = ($mismatches.Count -eq 0); Mismatches = $mismatches }
        }
        'cfg_upsert' {
            $current = Get-ConfigInstance -Binding $Binding -Domain $Operation.Domain -Type $Operation.Type -Instance $Operation.Instance
            $mismatches = @()
            foreach ($field in $Operation.Desired.PSObject.Properties) {
                $actual = [string](Get-ObjectProperty -Object $current.Attributes -Name $field.Name -Required)
                if ($actual -ne [string]$field.Value) { $mismatches += "$($field.Name):$actual!=$($field.Value)" }
            }
            return [pscustomobject]@{ Kind = $Operation.Kind; Target = "$($Operation.Domain)/$($Operation.Type)/$($Operation.Instance)"; Passed = ($mismatches.Count -eq 0); Mismatches = $mismatches }
        }
        'cfg_delete' {
            $current = Get-ConfigInstance -Binding $Binding -Domain $Operation.Domain -Type $Operation.Type -Instance $Operation.InstanceKey -AllowMissing
            return [pscustomobject]@{
                Kind = $Operation.Kind
                Target = "$($Operation.Domain)/$($Operation.Type)/$($Operation.InstanceKey)"
                Passed = ($null -eq $current)
                Actual = if ($null -eq $current) { 'absent' } else { 'present' }
                Expected = 'absent'
            }
        }
        'rapid_set_init' {
            $actual = Get-RapidDataValue -Binding $Binding -Task $Operation.Task -Module $Operation.Module -Name $Operation.Name
            return [pscustomobject]@{ Kind = $Operation.Kind; Target = "$($Operation.Task)/$($Operation.Module)/$($Operation.Name)"; Passed = ($actual -eq $Operation.Desired); Actual = $actual; Expected = $Operation.Desired }
        }
        'rapid_module_put' {
            $online = Get-RapidModuleText -Binding $Binding -Task $Operation.Task -Module $Operation.Module
            $actualHash = Get-Sha256Text -Text $online
            return [pscustomobject]@{ Kind = $Operation.Kind; Target = "$($Operation.Task)/$($Operation.Module)"; Passed = ($actualHash -eq $Operation.SourceSha256); ActualSourceSha256 = $actualHash; ExpectedSourceSha256 = $Operation.SourceSha256 }
        }
        'rapid_module_delete' {
            $online = Get-RapidModuleText -Binding $Binding -Task $Operation.Task -Module $Operation.Module -AllowMissing
            return [pscustomobject]@{ Kind = $Operation.Kind; Target = "$($Operation.Task)/$($Operation.Module)"; Passed = ($null -eq $online); Actual = if ($null -eq $online) { 'absent' } else { 'present' }; Expected = 'absent' }
        }
        'cfg_file_load' {
            $checks = @()
            $inventories = @{}
            foreach ($type in @($Operation.ParsedEntries.Type | Sort-Object -Unique)) {
                $inventories[[string]$type] = @(Get-ConfigInstances -Binding $Binding -Domain $Operation.Domain -Type ([string]$type))
            }
            foreach ($entry in @($Operation.ParsedEntries)) {
                $passed = Test-CfgEntryPresent -Entry $entry -Instances @($inventories[[string]$entry.Type])
                $checks += [pscustomobject]@{
                    Target = "cfg-file/$($Operation.Domain)/$($entry.Type)"
                    Passed = $passed
                    ExpectedFields = $entry.Fields
                    Error = if ($passed) { $null } else { 'CFG entry missing or field mismatch' }
                }
            }
            $cfgInstances = Get-ObjectProperty -Object $Operation.Verify -Name 'cfgInstances'
            if ($null -ne $cfgInstances) {
                foreach ($item in @($cfgInstances)) {
                    $current = Get-ConfigInstance -Binding $Binding -Domain ([string]$item.domain) -Type ([string]$item.type) -Instance ([string]$item.instance)
                    $mismatches = @()
                    foreach ($field in $item.fields.PSObject.Properties) {
                        $actual = [string](Get-ObjectProperty -Object $current.Attributes -Name $field.Name -Required)
                        if ($actual -ne [string]$field.Value) { $mismatches += "$($field.Name):$actual!=$($field.Value)" }
                    }
                    $checks += [pscustomobject]@{ Target = "$($item.domain)/$($item.type)/$($item.instance)"; Passed = ($mismatches.Count -eq 0); Mismatches = $mismatches }
                }
            }
            $signalNames = Get-ObjectProperty -Object $Operation.Verify -Name 'signals'
            if ($null -ne $signalNames) {
                foreach ($signalName in @($signalNames)) {
                    try { $signal = Get-IoSignal -Binding $Binding -Name ([string]$signalName); $checks += [pscustomobject]@{ Target = "signal/$signalName"; Passed = $true; Value = $signal.Value; Quality = $signal.Quality } }
                    catch { $checks += [pscustomobject]@{ Target = "signal/$signalName"; Passed = $false; Error = $_.Exception.Message } }
                }
            }
            $configSignals = Get-ObjectProperty -Object $Operation.Verify -Name 'configSignals'
            if ($null -ne $configSignals) {
                $instances = @(Get-ConfigInstances -Binding $Binding -Domain eio -Type 'EIO_SIGNAL')
                $byName = @{}
                foreach ($instance in $instances) {
                    $name = [string](Get-ObjectProperty -Object $instance.Attributes -Name 'Name')
                    if (-not [string]::IsNullOrWhiteSpace($name)) { $byName[$name] = $instance }
                }
                foreach ($expectedSignal in @($configSignals)) {
                    $name = [string](Get-ObjectProperty -Object $expectedSignal -Name 'name' -Required)
                    if (-not $byName.ContainsKey($name)) {
                        $checks += [pscustomobject]@{ Target = "config-signal/$name"; Passed = $false; Error = 'missing' }
                        continue
                    }
                    $mismatches = @()
                    $fields = Get-ObjectProperty -Object $expectedSignal -Name 'fields'
                    if ($null -ne $fields) {
                        foreach ($field in $fields.PSObject.Properties) {
                            $actual = [string](Get-ObjectProperty -Object $byName[$name].Attributes -Name $field.Name -Required)
                            if ($actual -ne [string]$field.Value) { $mismatches += "$($field.Name):$actual!=$($field.Value)" }
                        }
                    }
                    $checks += [pscustomobject]@{ Target = "config-signal/$name"; Passed = ($mismatches.Count -eq 0); Mismatches = $mismatches }
                }
            }
            return [pscustomobject]@{ Kind = $Operation.Kind; Target = $Operation.LocalPath; Passed = (@($checks | Where-Object { -not $_.Passed }).Count -eq 0); Checks = $checks }
        }
    }
}

function Invoke-AbbPreparedJob {
    param([Parameter(Mandatory = $true)][string]$Token)
    if (-not $script:PreparedJobs.ContainsKey($Token)) { throw 'Unknown prepared token.' }
    $prepared = $script:PreparedJobs[$Token]
    Assert-PreparedJobUnchanged -Prepared $prepared
    $prepared.Used = $true

    $totalTimer = [Diagnostics.Stopwatch]::StartNew()
    $phaseTimings = [ordered]@{}
    $results = [System.Collections.Generic.List[object]]::new()
    $changedOperations = @($prepared.Operations | Where-Object NeedsChange)
    $alias = $prepared.Alias
    $metricsBefore = Copy-AliasMetrics -Alias $alias
    $binding = Get-ControllerBinding -Alias $alias -BypassCircuit
    $mastershipHeld = $false
    $controllerModified = $false
    $controllerWriteUnknown = $false
    $writeInFlight = $false
    $stagingName = 'codex_mcp_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '_' + $Token.Substring(0,8)
    $stagingCreated = $false
    $stagingRemoved = $false
    $rapidTasksToBuild = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    try {
        Write-WorkerProgress -Event ([pscustomobject]@{
            Phase = 'preflight'
            At = [DateTime]::UtcNow.ToString('o')
            Data = [pscustomobject]@{ controller = $alias; changedOperations = $changedOperations.Count }
        })
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $identity = Get-BindingIdentity -Binding $binding
        Assert-ExpectedIdentity -Identity $identity -Config $binding.Config
        $state = Get-ControllerState -Binding $binding
        Assert-SafeStoppedState -State $state -AllowedControllerStates @($prepared.Manifest.safety.allowedControllerStates)
        # Do not read every operation twice. The authoritative optimistic-lock
        # check runs after mastership is acquired (or inside CFG file load).
        # Identity and stopped-state checks remain here so unsafe jobs fail before
        # staging or requesting write access.
        $timer.Stop(); $phaseTimings.Preflight = $timer.ElapsedMilliseconds

        if ($changedOperations.Count -eq 0) {
            $verification = @($prepared.Operations | ForEach-Object { Test-OperationVerification -Binding $binding -Operation $_ })
            $failed = @($verification | Where-Object { -not $_.Passed })
            if ($failed.Count -gt 0) { throw "No-op verification failed: $($failed | ConvertTo-Json -Depth 12 -Compress)" }
            $phaseTimings.ConfigFileLoad = 0
            $phaseTimings.BatchWriteAndBuild = 0
            $phaseTimings.RestartAndReconnect = 0
            $phaseTimings.IndependentReadback = 0
            $totalTimer.Stop()
            $metricsAfter = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{
                Applied = $true; NoOp = $true; Controller = $alias; Identity = $identity; State = $state
                ManifestSha256 = $prepared.ManifestHash; ChangedOperationCount = 0
                SkippedNoOpCount = $prepared.Operations.Count; Results = @(); Verification = $verification
                PhaseTimingsMs = [pscustomobject]$phaseTimings; TotalElapsedMs = $totalTimer.ElapsedMilliseconds
                Metrics = Get-MetricDeltaResult -Before $metricsBefore -After $metricsAfter
                RobotStarted = $false; MotorsEnabled = $false; ControllerModified = $false
            }
        }

        if (@($changedOperations | Where-Object { $_.Kind -in @('rapid_module_put','cfg_file_load') }).Count -gt 0) {
            New-RemoteStagingDirectory -Binding $binding -Name $stagingName
            $stagingCreated = $true
        }

        # Configuration-file loads run first because RW6 may reset the RWS transport.
        if (@($changedOperations | Where-Object Kind -eq 'cfg_file_load').Count -gt 0) {
            Write-WorkerProgress -Event ([pscustomobject]@{
                Phase = 'configuration_file_load'
                At = [DateTime]::UtcNow.ToString('o')
                Data = [pscustomobject]@{ controller = $alias }
            })
        }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        foreach ($operation in @($changedOperations | Where-Object Kind -eq 'cfg_file_load')) {
            $cfgResult = Invoke-CfgFileLoad -Binding $binding -Operation $operation -RemoteDirectory $stagingName
            $results.Add($cfgResult)
            if ($cfgResult.TransportUnknown) { $controllerWriteUnknown = $true }
            else { $controllerModified = $true }
            $binding = Reconnect-ControllerBinding -Alias $alias
            $identity = $binding.Identity
            Assert-ExpectedIdentity -Identity $identity -Config $binding.Config
            $state = Get-ControllerState -Binding $binding
            Assert-SafeStoppedState -State $state -AllowedControllerStates @($prepared.Manifest.safety.allowedControllerStates)
        }
        $timer.Stop(); $phaseTimings.ConfigFileLoad = $timer.ElapsedMilliseconds

        $remaining = @($changedOperations | Where-Object Kind -ne 'cfg_file_load')
        if ($remaining.Count -gt 0) {
            Write-WorkerProgress -Event ([pscustomobject]@{
                Phase = 'mastership_and_batch_write'
                At = [DateTime]::UtcNow.ToString('o')
                Data = [pscustomobject]@{ controller = $alias; operations = $remaining.Count }
            })
            $timer = [Diagnostics.Stopwatch]::StartNew()
            Request-Mastership -Binding $binding
            $mastershipHeld = $true
            $identity = Get-BindingIdentity -Binding $binding
            Assert-ExpectedIdentity -Identity $identity -Config $binding.Config
            $state = Get-ControllerState -Binding $binding
            Assert-SafeStoppedState -State $state -AllowedControllerStates @($prepared.Manifest.safety.allowedControllerStates)
            $script:ConfigListCache.Clear()
            foreach ($operation in $remaining) { Assert-OperationPrecondition -Binding $binding -Operation $operation }

            foreach ($operation in $remaining) {
                switch ($operation.Kind) {
                    'cfg_set' {
                        $encodedType = [uri]::EscapeDataString($operation.Type)
                        $encodedInstance = [uri]::EscapeDataString($operation.Instance)
                        $form = @{}
                        foreach ($field in $operation.Desired.PSObject.Properties) { $form[$field.Name] = [string]$field.Value }
                        $writeInFlight = $true
                        $response = Invoke-BindingRequest -Binding $binding -Method POST -Path "/rw/cfg/$($operation.Domain)/$encodedType/instances/$encodedInstance`?action=set" -Form $form -NoReconnect
                        $writeInFlight = $false
                        Assert-HttpStatus -Response $response -Allowed @(204) -Operation "Set configuration $($operation.Type)/$($operation.Instance)"
                        $controllerModified = $true
                        $results.Add([pscustomobject]@{ Kind = $operation.Kind; Target = "$($operation.Domain)/$($operation.Type)/$($operation.Instance)"; Http = [int]$response.StatusCode })
                    }
                    'cfg_upsert' {
                        $encodedType = [uri]::EscapeDataString($operation.Type)
                        $encodedInstance = [uri]::EscapeDataString($operation.Instance)
                        $createHttp = $null
                        if (-not $operation.BeforeExists) {
                            $writeInFlight = $true
                            $create = Invoke-BindingRequest -Binding $binding -Method POST -Path "/rw/cfg/$($operation.Domain)/$encodedType/instances?action=create-default" -Form @{ name = $operation.Instance } -NoReconnect
                            $writeInFlight = $false
                            Assert-HttpStatus -Response $create -Allowed @(201) -Operation "Create configuration $($operation.Type)/$($operation.Instance)"
                            $controllerModified = $true
                            $createHttp = [int]$create.StatusCode
                        }
                        $form = @{}
                        foreach ($field in $operation.Desired.PSObject.Properties) { $form[$field.Name] = [string]$field.Value }
                        $writeInFlight = $true
                        $set = Invoke-BindingRequest -Binding $binding -Method POST -Path "/rw/cfg/$($operation.Domain)/$encodedType/instances/$encodedInstance`?action=set" -Form $form -NoReconnect
                        $writeInFlight = $false
                        Assert-HttpStatus -Response $set -Allowed @(204) -Operation "Set configuration $($operation.Type)/$($operation.Instance)"
                        $controllerModified = $true
                        $results.Add([pscustomobject]@{ Kind = $operation.Kind; Target = "$($operation.Domain)/$($operation.Type)/$($operation.Instance)"; CreateHttp = $createHttp; SetHttp = [int]$set.StatusCode })
                    }
                    'cfg_delete' {
                        $encodedType = [uri]::EscapeDataString($operation.Type)
                        $encodedInstance = [uri]::EscapeDataString($operation.DeleteKey)
                        $writeInFlight = $true
                        $response = Invoke-BindingRequest -Binding $binding -Method DELETE -Path "/rw/cfg/$($operation.Domain)/$encodedType/instances/$encodedInstance" -NoReconnect
                        $writeInFlight = $false
                        Assert-HttpStatus -Response $response -Allowed @(200,204) -Operation "Delete configuration $($operation.Type)/$($operation.InstanceKey)"
                        $controllerModified = $true
                        $results.Add([pscustomobject]@{ Kind = $operation.Kind; Target = "$($operation.Domain)/$($operation.Type)/$($operation.InstanceKey)"; Http = [int]$response.StatusCode })
                    }
                    'rapid_set_init' {
                        $path = "/rw/rapid/symbol/data/RAPID/$($operation.Task)/$($operation.Module)/$($operation.Name)`?action=setInitValue"
                        $writeInFlight = $true
                        $response = Invoke-BindingRequest -Binding $binding -Method POST -Path $path -Form @{ value = $operation.Desired } -NoReconnect
                        $writeInFlight = $false
                        Assert-HttpStatus -Response $response -Allowed @(204) -Operation "Set RAPID data $($operation.Module).$($operation.Name)"
                        $controllerModified = $true
                        $results.Add([pscustomobject]@{ Kind = $operation.Kind; Target = "$($operation.Task)/$($operation.Module)/$($operation.Name)"; Http = [int]$response.StatusCode })
                    }
                    'rapid_module_put' {
                        $upload = Upload-StagedFile -Binding $binding -RemoteDirectory $stagingName -LocalPath $operation.LocalPath -ArtifactBytes $operation.ArtifactBytes
                        # replace=true atomically replaces an already loaded module and
                        # avoids the missing-module window caused by unload-then-load.
                        $writeInFlight = $true
                        $load = Invoke-BindingRequest -Binding $binding -Method POST -Path "/rw/rapid/tasks/$($operation.Task)?action=loadmod" -Form @{ modulepath = $upload.ControllerPath; replace = 'true' } -TimeoutSeconds (Get-ConfigTimeoutSeconds -Config $binding.Config -Kind long) -NoReconnect
                        $writeInFlight = $false
                        Assert-HttpStatus -Response $load -Allowed @(200,204) -Operation "Load RAPID module $($operation.Module)"
                        $controllerModified = $true
                        $null = $rapidTasksToBuild.Add($operation.Task)
                        $results.Add([pscustomobject]@{ Kind = $operation.Kind; Target = "$($operation.Task)/$($operation.Module)"; UploadHttp = $upload.Http; LoadHttp = [int]$load.StatusCode })
                    }
                    'rapid_module_delete' {
                        $writeInFlight = $true
                        $unload = Invoke-BindingRequest -Binding $binding -Method POST -Path "/rw/rapid/tasks/$($operation.Task)?action=unloadmod" -Form @{ module = $operation.Module } -NoReconnect
                        $writeInFlight = $false
                        Assert-HttpStatus -Response $unload -Allowed @(200,204) -Operation "Delete RAPID module $($operation.Module)"
                        $controllerModified = $true
                        $null = $rapidTasksToBuild.Add($operation.Task)
                        $results.Add([pscustomobject]@{ Kind = $operation.Kind; Target = "$($operation.Task)/$($operation.Module)"; Http = [int]$unload.StatusCode })
                    }
                }
            }

            foreach ($task in $rapidTasksToBuild) {
                $writeInFlight = $true
                $build = Invoke-BindingRequest -Binding $binding -Method POST -Path "/rw/rapid/tasks/${task}?action=build" -Form @{} -TimeoutSeconds (Get-ConfigTimeoutSeconds -Config $binding.Config -Kind long) -NoReconnect
                $writeInFlight = $false
                Assert-HttpStatus -Response $build -Allowed @(200,204) -Operation "Build RAPID task $task"
                $errorCount = Get-BuildErrorCount -Binding $binding -Task $task
                if ($errorCount -ne 0) { throw "Build reported $errorCount error(s) for $task" }
            }
            $release = Release-MastershipBestEffort -Binding $binding
            if ($null -eq $release -or $release.StatusCode -ne 204) {
                Close-ControllerBinding -Alias $alias
                $mastershipHeld = $false
                throw 'Mastership release was not confirmed; the RWS session was logged out and closed to force release.'
            }
            $mastershipHeld = $false
            $timer.Stop(); $phaseTimings.BatchWriteAndBuild = $timer.ElapsedMilliseconds
        } else {
            $phaseTimings.BatchWriteAndBuild = 0
        }

        $restart = Get-ObjectProperty -Object $prepared.Manifest -Name 'restart'
        if ($null -ne $restart -and [bool]$restart.required) {
            Write-WorkerProgress -Event ([pscustomobject]@{
                Phase = 'restart_and_reconnect'
                At = [DateTime]::UtcNow.ToString('o')
                Data = [pscustomobject]@{ controller = $alias; timeoutSeconds = [int]$restart.timeoutSeconds }
            })
            $timer = [Diagnostics.Stopwatch]::StartNew()
            $restartResult = Invoke-OrdinaryRestartAndWait -Alias $alias -TimeoutSeconds ([int]$restart.timeoutSeconds)
            $results.Add([pscustomobject]@{ Kind = 'restart'; Result = $restartResult })
            $binding = Get-ControllerBinding -Alias $alias -BypassCircuit
            $timer.Stop(); $phaseTimings.RestartAndReconnect = $timer.ElapsedMilliseconds
        } else {
            Close-ControllerBinding -Alias $alias
            $binding = New-ControllerBinding -Alias $alias -BypassCircuit
            $phaseTimings.RestartAndReconnect = 0
        }

        Write-WorkerProgress -Event ([pscustomobject]@{
            Phase = 'independent_readback'
            At = [DateTime]::UtcNow.ToString('o')
            Data = [pscustomobject]@{ controller = $alias }
        })
        $timer = [Diagnostics.Stopwatch]::StartNew()
        # New-ControllerBinding (directly or inside restart recovery) already
        # performed the independent identity-locked /rw/system read.
        $verifyIdentity = $binding.Identity
        Assert-ExpectedIdentity -Identity $verifyIdentity -Config $binding.Config
        $verifyState = Get-ControllerState -Binding $binding
        Assert-SafeStoppedState -State $verifyState -AllowedControllerStates @($prepared.Manifest.safety.allowedControllerStates)
        $verification = @($prepared.Operations | ForEach-Object { Test-OperationVerification -Binding $binding -Operation $_ })
        $failed = @($verification | Where-Object { -not $_.Passed })
        foreach ($task in $rapidTasksToBuild) {
            $count = Get-BuildErrorCount -Binding $binding -Task $task
            if ($count -ne 0) { $failed += [pscustomobject]@{ Kind = 'build'; Target = $task; Passed = $false; ErrorCount = $count } }
        }
        if ($failed.Count -gt 0) { throw "Independent verification failed: $($failed | ConvertTo-Json -Depth 12 -Compress)" }
        $timer.Stop(); $phaseTimings.IndependentReadback = $timer.ElapsedMilliseconds

        if ($stagingCreated) {
            $stagingCleanup = Remove-RemoteStagingDirectoryBestEffort -Binding $binding -RemoteDirectory $stagingName
            $stagingRemoved = [bool]$stagingCleanup.Removed
            $results.Add([pscustomobject]@{ Kind = 'staging_cleanup'; Result = $stagingCleanup })
        }

        $totalTimer.Stop()
        $metricsAfter = Copy-AliasMetrics -Alias $alias
        return [pscustomobject]@{
            Applied = $true
            Controller = $alias
            Identity = $verifyIdentity
            State = $verifyState
            ManifestSha256 = $prepared.ManifestHash
            ChangedOperationCount = $changedOperations.Count
            SkippedNoOpCount = @($prepared.Operations | Where-Object { -not $_.NeedsChange }).Count
            Results = $results
            Verification = $verification
            PhaseTimingsMs = [pscustomobject]$phaseTimings
            TotalElapsedMs = $totalTimer.ElapsedMilliseconds
            Metrics = Get-MetricDeltaResult -Before $metricsBefore -After $metricsAfter
            RobotStarted = $false
            MotorsEnabled = $false
            ControllerModified = $controllerModified
        }
    }
    catch {
        $failureMessage = $_.Exception.Message
        if ($writeInFlight) { $controllerWriteUnknown = $true }
        if ($mastershipHeld -and $null -ne $binding) {
            $release = Release-MastershipBestEffort -Binding $binding
            if ($null -eq $release -or $release.StatusCode -ne 204) { Close-ControllerBinding -Alias $alias }
            $mastershipHeld = $false
        }

        $postFailure = $null
        try {
            Close-ControllerBinding -Alias $alias
            $binding = New-ControllerBinding -Alias $alias -BypassCircuit
            $postIdentity = $binding.Identity
            Assert-ExpectedIdentity -Identity $postIdentity -Config $binding.Config
            $postState = Get-ControllerState -Binding $binding
            $postVerificationList = [System.Collections.Generic.List[object]]::new()
            foreach ($preparedOperation in @($prepared.Operations)) {
                try { $postVerificationList.Add((Test-OperationVerification -Binding $binding -Operation $preparedOperation)) }
                catch { $postVerificationList.Add([pscustomobject]@{ Kind = $preparedOperation.Kind; Passed = $false; Error = $_.Exception.Message }) }
            }
            $postVerification = $postVerificationList.ToArray()
            $postBuild = @()
            foreach ($task in @($prepared.Operations | Where-Object { $_.Kind -in @('rapid_module_put','rapid_module_delete') } | ForEach-Object Task | Sort-Object -Unique)) {
                try {
                    $count = Get-BuildErrorCount -Binding $binding -Task ([string]$task)
                    $postBuild += [pscustomobject]@{ Task = $task; ErrorCount = $count; Passed = ($count -eq 0) }
                } catch { $postBuild += [pscustomobject]@{ Task = $task; Passed = $false; Error = $_.Exception.Message } }
            }
            $postFailure = [pscustomobject]@{
                ReadbackSucceeded = $true; Identity = $postIdentity; State = $postState
                Verification = $postVerification; Build = $postBuild
            }
        }
        catch {
            $postFailure = [pscustomobject]@{ ReadbackSucceeded = $false; Error = $_.Exception.Message }
        }

        if ($stagingCreated -and $null -ne $binding) {
            $stagingCleanup = Remove-RemoteStagingDirectoryBestEffort -Binding $binding -RemoteDirectory $stagingName
            $stagingRemoved = [bool]$stagingCleanup.Removed
            $results.Add([pscustomobject]@{ Kind = 'staging_cleanup'; Result = $stagingCleanup })
        }
        $totalTimer.Stop()
        $metricsAfter = Copy-AliasMetrics -Alias $alias
        return [pscustomobject]@{
            Applied = $false
            PartialApply = ($controllerModified -or $controllerWriteUnknown)
            ControllerModified = $controllerModified
            ControllerWriteUnknown = $controllerWriteUnknown
            NeedsFreshPlan = $true
            Controller = $alias
            ManifestSha256 = $prepared.ManifestHash
            Failure = $failureMessage
            Results = $results
            PostFailureReadback = $postFailure
            PhaseTimingsMs = [pscustomobject]$phaseTimings
            TotalElapsedMs = $totalTimer.ElapsedMilliseconds
            Metrics = Get-MetricDeltaResult -Before $metricsBefore -After $metricsAfter
            RobotStarted = $false
            MotorsEnabled = $false
        }
    }
    finally {
        if ($mastershipHeld -and $null -ne $binding) {
            $release = Release-MastershipBestEffort -Binding $binding
            if ($null -eq $release -or $release.StatusCode -ne 204) { Close-ControllerBinding -Alias $alias }
        }
        if ($stagingCreated -and -not $stagingRemoved -and $null -ne $binding) {
            $null = Remove-RemoteStagingDirectoryBestEffort -Binding $binding -RemoteDirectory $stagingName
        }
        $script:PreparedJobs.Remove($Token)
    }
}

function Verify-AbbPreparedToken {
    param([Parameter(Mandatory = $true)][string]$Token)
    try {
        $job = $script:PreparedJobs[$Token]
        $alias = $job.Alias
        $metricsBefore = $job.MetricsAtStart
        Close-ControllerBinding -Alias $alias
        $binding = New-ControllerBinding -Alias $alias -BypassCircuit
        $identity = $binding.Identity
        Assert-ExpectedIdentity -Identity $identity -Config $binding.Config
        $state = Get-ControllerState -Binding $binding
        Assert-SafeStoppedState -State $state -AllowedControllerStates @($job.Manifest.safety.allowedControllerStates)
        $verification = @($job.Operations | ForEach-Object { Test-OperationVerification -Binding $binding -Operation $_ })
        $buildVerification = @()
        foreach ($task in @($job.Operations | Where-Object { $_.Kind -in @('rapid_module_put','rapid_module_delete') } | ForEach-Object Task | Sort-Object -Unique)) {
            $count = Get-BuildErrorCount -Binding $binding -Task ([string]$task)
            $buildVerification += [pscustomobject]@{ Task = $task; ErrorCount = $count; Passed = ($count -eq 0) }
        }
        $metricsAfter = Copy-AliasMetrics -Alias $alias
        return [pscustomobject]@{
            Verified = (@($verification | Where-Object { -not $_.Passed }).Count -eq 0 -and @($buildVerification | Where-Object { -not $_.Passed }).Count -eq 0)
            Controller = $alias
            Identity = $identity
            State = $state
            Verification = $verification
            BuildVerification = $buildVerification
            Metrics = Get-MetricDeltaResult -Before $metricsBefore -After $metricsAfter
            ControllerModified = $false
        }
    }
    finally {
        $script:PreparedJobs.Remove($Token)
    }
}

function Verify-AbbChangeset {
    param([Parameter(Mandatory = $true)][object]$Changeset)
    $prepared = Prepare-AbbChangeset -Changeset $Changeset
    return Verify-AbbPreparedToken -Token $prepared.Token
}

function Get-AbbBackupValue {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory)]
        [string]$Name,

        [AllowNull()]
        [object]$Default = $null
    )

    if ($null -eq $Object) {
        return $Default
    }

    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in $Object.Keys) {
            if ([string]::Equals([string]$key, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $Object[$key]
            }
        }
        return $Default
    }

    $property = $Object.PSObject.Properties |
        Where-Object { [string]::Equals($_.Name, $Name, [System.StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if ($null -eq $property) {
        return $Default
    }
    return $property.Value
}

function ConvertTo-AbbBackupIdentity {
    param(
        [Parameter(Mandatory)]
        [object]$Identity,

        [AllowNull()]
        [object]$Binding
    )

    $endpoint = [string](Get-AbbBackupValue -Object $Identity -Name 'Endpoint' -Default '')
    if ([string]::IsNullOrWhiteSpace($endpoint) -and $null -ne $Binding) {
        $config = Get-AbbBackupValue -Object $Binding -Name 'Config'
        $endpoint = [string](Get-AbbBackupValue -Object $config -Name 'baseUrl' -Default '')
    }

    return [pscustomobject][ordered]@{
        Endpoint  = $endpoint.TrimEnd('/')
        Name      = [string](Get-AbbBackupValue -Object $Identity -Name 'Name' -Default '')
        SystemId  = [string](Get-AbbBackupValue -Object $Identity -Name 'SystemId' -Default '')
        RobotWare = [string](Get-AbbBackupValue -Object $Identity -Name 'RobotWare' -Default '')
    }
}

function ConvertTo-AbbBackupSafety {
    param(
        [Parameter(Mandatory)]
        [object]$State
    )

    return [pscustomobject][ordered]@{
        RapidState      = [string](Get-AbbBackupValue -Object $State -Name 'RapidState' -Default '')
        ControllerState = [string](Get-AbbBackupValue -Object $State -Name 'ControllerState' -Default '')
    }
}

function ConvertTo-AbbBackupRemoteView {
    param(
        [AllowNull()]
        [object]$Snapshot,

        [bool]$DefaultExists = $false,

        [AllowNull()]
        [object[]]$Files
    )

    if ($null -eq $Snapshot) {
        return [pscustomobject][ordered]@{
            Exists     = $DefaultExists
            FileCount  = 0
            TotalBytes = [long]0
            Files      = @()
        }
    }

    $exists = [bool](Get-AbbBackupValue -Object $Snapshot -Name 'Exists' -Default $DefaultExists)
    $allSizesKnown = [bool](Get-AbbBackupValue -Object $Snapshot -Name 'AllSizesKnown' -Default $true)
    if ($exists -and -not $allSizesKnown) {
        throw 'Remote ABB backup tree contains files with unknown sizes.'
    }

    $sourceFiles = if ($null -ne $Files) {
        @($Files)
    }
    else {
        @(Get-AbbBackupValue -Object $Snapshot -Name 'Files' -Default @())
    }
    $files = @(
        $sourceFiles |
            ForEach-Object {
                [pscustomobject][ordered]@{
                    RelativePath = [string](Get-AbbBackupValue -Object $_ -Name 'RelativePath' -Default '')
                    Size         = [long](Get-AbbBackupValue -Object $_ -Name 'RemoteSize' -Default (Get-AbbBackupValue -Object $_ -Name 'Size' -Default 0))
                }
            } |
            Sort-Object RelativePath
    )
    $totalBytes = [long](Get-AbbBackupValue -Object $Snapshot -Name 'KnownBytes' -Default 0)
    if ($files.Count -gt 0 -and $totalBytes -eq 0) {
        $totalBytes = [long](($files | Measure-Object -Property Size -Sum).Sum)
    }

    return [pscustomobject][ordered]@{
        Exists     = $exists
        FileCount  = [int]$files.Count
        TotalBytes = $totalBytes
        Files      = $files
    }
}

function Resolve-AbbBackupPlanPaths {
    param(
        [Parameter(Mandatory)]
        [string]$LocalRoot,

        [Parameter(Mandatory)]
        [string]$BackupName
    )

    $name = $BackupName.Trim()
    Assert-SafeRemotePathSegment -Name $name
    $resolvedRoot = Resolve-AllowedLocalRoot -Path $LocalRoot -Registry $script:Registry
    $localPath = [System.IO.Path]::GetFullPath((Join-Path -Path $resolvedRoot -ChildPath $name))
    $rootPrefix = $resolvedRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $localPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Backup target escapes the allowed local root: $localPath"
    }

    return [pscustomobject][ordered]@{
        LocalRoot = $resolvedRoot
        LocalPath = $localPath
    }
}

function Assert-AbbBackupIdentityMatch {
    param(
        [Parameter(Mandatory)]
        [object]$Expected,

        [Parameter(Mandatory)]
        [object]$Actual
    )

    foreach ($field in @('Endpoint', 'Name', 'SystemId', 'RobotWare')) {
        $expectedValue = [string](Get-AbbBackupValue -Object $Expected -Name $field -Default '')
        $actualValue = [string](Get-AbbBackupValue -Object $Actual -Name $field -Default '')
        if (-not [string]::Equals(
                $expectedValue.TrimEnd('/'),
                $actualValue.TrimEnd('/'),
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw "Backup controller identity changed for ${field}: expected '$expectedValue', actual '$actualValue'."
        }
    }
}

function Get-AbbBackupPlanSha256 {
    param(
        [Parameter(Mandatory)]
        [object]$Plan
    )

    $json = $Plan | ConvertTo-Json -Depth 30 -Compress
    return Get-Sha256Text -Text $json
}

function Plan-AbbBackup {
    param(
        [Parameter(Mandatory)]
        [string]$Alias,

        [Parameter(Mandatory)]
        [string]$LocalRoot,

        [Parameter(Mandatory)]
        [string]$BackupName,

        [string]$Cell = '',

        [string]$Robot = '',

        [ValidateRange(30, 1800)]
        [int]$TimeoutSeconds = 600
    )

    $controllerAlias = $Alias.Trim()
    if ([string]::IsNullOrWhiteSpace($controllerAlias)) {
        throw 'Controller alias is required for ABB backup planning.'
    }

    $paths = Resolve-AbbBackupPlanPaths -LocalRoot $LocalRoot -BackupName $BackupName
    $localExists = Test-Path -LiteralPath $paths.LocalPath
    if ($localExists) {
        throw "Local backup target already exists; overwrite is forbidden: $($paths.LocalPath)"
    }

    $bindingWasOpen = $script:Bindings.ContainsKey($controllerAlias)
    $binding = Get-ControllerBinding -Alias $controllerAlias -BypassCircuit
    $rawIdentity = if ($bindingWasOpen) {
        Get-BindingIdentity -Binding $binding
    }
    else {
        $binding.Identity
    }
    Assert-ExpectedIdentity -Identity $rawIdentity -Config $binding.Config
    $identity = ConvertTo-AbbBackupIdentity -Identity $rawIdentity -Binding $binding
    $state = Get-ControllerState -Binding $binding
    Assert-SafeStoppedState -State $state -AllowedControllerStates @('guardstop', 'motoroff')
    $safety = ConvertTo-AbbBackupSafety -State $state

    $normalizedBackupName = $BackupName.Trim()
    if (Test-AbbCollisionResistantBackupName -BackupName $normalizedBackupName) {
        # Avoid the RW6 FileService bug where probing a missing directory can
        # block far beyond the HTTP timeout. The run nonce prevents collision;
        # apply still verifies the created tree and every downloaded file.
        $remoteSnapshot = [pscustomobject]@{
            Exists         = $false
            BackupName     = $normalizedBackupName
            RemotePath     = '/fileservice/$SYSPAR/' + $normalizedBackupName
            FileCount      = 0
            KnownSizeCount = 0
            KnownBytes     = [long]0
            AllSizesKnown  = $true
            Files          = @()
        }
    }
    else {
        $remoteSnapshot = Get-AbbRemoteBackupSnapshot `
            -Session $binding.Session `
            -BackupName $normalizedBackupName `
            -TimeoutSeconds (Get-ConfigTimeoutSeconds -Config $binding.Config -Kind request) `
            -MaxAttempts 1 `
            -Shallow
        if ([bool]$remoteSnapshot.Exists) {
            throw "Remote ABB backup target already exists; overwrite is forbidden: $($remoteSnapshot.RemotePath)"
        }
    }
    $remoteBefore = ConvertTo-AbbBackupRemoteView -Snapshot $remoteSnapshot

    $plan = [pscustomobject][ordered]@{
        Controller     = $controllerAlias
        Identity       = $identity
        BackupName     = $normalizedBackupName
        Cell           = ([string]$Cell).Trim()
        Robot          = ([string]$Robot).Trim()
        LocalRoot      = [string]$paths.LocalRoot
        LocalPath      = [string]$paths.LocalPath
        RemotePath     = [string]$remoteSnapshot.RemotePath
        TimeoutSeconds = $TimeoutSeconds
        Safety         = $safety
        RemoteBefore   = $remoteBefore
    }
    $planSha256 = Get-AbbBackupPlanSha256 -Plan $plan
    $token = [guid]::NewGuid().ToString('N')
    $createdAt = [datetime]::UtcNow
    $expiresAt = $createdAt.AddMinutes(10)
    $script:PreparedBackups[$token] = [pscustomobject]@{
        Token      = $token
        Plan       = $plan
        PlanSha256 = $planSha256
        CreatedAt  = $createdAt
        ExpiresAt  = $expiresAt
        Used       = $false
    }

    return [pscustomobject][ordered]@{
        Planned            = $true
        Controller         = $controllerAlias
        Identity           = $identity
        BackupName         = $plan.BackupName
        Cell               = $plan.Cell
        Robot              = $plan.Robot
        LocalRoot          = $plan.LocalRoot
        LocalPath          = $plan.LocalPath
        RemotePath         = $plan.RemotePath
        TimeoutSeconds     = $TimeoutSeconds
        Token              = $token
        PlanSha256         = $planSha256
        ExpiresAtUtc       = $expiresAt.ToString('o')
        Safety             = $safety
        RemoteBefore       = $remoteBefore
        RemoteExists       = $false
        LocalExists        = $false
        ControllerModified = $false
    }
}

function Get-AbbPreparedBackupForApply {
    param(
        [Parameter(Mandatory)]
        [string]$Token
    )

    if (-not $script:PreparedBackups.ContainsKey($Token)) {
        throw 'Unknown or already-consumed ABB backup plan token.'
    }

    $prepared = $script:PreparedBackups[$Token]
    if ([bool]$prepared.Used) {
        throw 'ABB backup plan token has already been consumed.'
    }
    if ([datetime]::UtcNow -gt [datetime]$prepared.ExpiresAt) {
        $script:PreparedBackups.Remove($Token)
        throw 'ABB backup plan token expired; create and approve a new plan.'
    }

    $actualSha256 = Get-AbbBackupPlanSha256 -Plan $prepared.Plan
    if (-not [string]::Equals(
            [string]$prepared.PlanSha256,
            [string]$actualSha256,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        $script:PreparedBackups.Remove($Token)
        throw 'ABB backup plan changed after approval; create and approve a new plan.'
    }

    $prepared.Used = $true
    return $prepared
}

function Invoke-AbbBackupPlan {
    param(
        [Parameter(Mandatory)]
        [string]$Token
    )

    $prepared = Get-AbbPreparedBackupForApply -Token $Token
    try {
        $plan = $prepared.Plan
        $alias = [string]$plan.Controller
        Write-WorkerProgress -Event ([pscustomobject]@{
            Phase = 'backup_preflight'
            At = [DateTime]::UtcNow.ToString('o')
            Data = [pscustomobject]@{ controller = $alias; backupName = [string]$plan.BackupName }
        })

        # Reuse the plan/bind RWS session instead of paying for a second Digest
        # handshake and controller session. Safety stays fresh: identity and
        # stopped state are read again immediately before the backup. The later
        # verify operation still creates an independent new session.
        $sessionWasOpen = $script:Bindings.ContainsKey($alias)
        $binding = Get-ControllerBinding -Alias $alias -BypassCircuit
        $rawIdentity = Get-BindingIdentity -Binding $binding
        Assert-ExpectedIdentity -Identity $rawIdentity -Config $binding.Config
        $binding.Identity = $rawIdentity
        $binding.VerifiedAt = (Get-Date).ToString('o')
        $identity = ConvertTo-AbbBackupIdentity -Identity $rawIdentity -Binding $binding
        Assert-AbbBackupIdentityMatch -Expected $plan.Identity -Actual $identity

        $state = Get-ControllerState -Binding $binding
        Assert-SafeStoppedState -State $state -AllowedControllerStates @('guardstop', 'motoroff')
        $safety = ConvertTo-AbbBackupSafety -State $state

        $paths = Resolve-AbbBackupPlanPaths -LocalRoot ([string]$plan.LocalRoot) -BackupName ([string]$plan.BackupName)
        if (-not [string]::Equals(
                [string]$paths.LocalPath,
                [string]$plan.LocalPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'Resolved local backup path changed after approval.'
        }
        if (Test-Path -LiteralPath $paths.LocalPath) {
            throw "Local backup target appeared after planning; overwrite is forbidden: $($paths.LocalPath)"
        }

        $requestTimeout = [Math]::Max(1, [Math]::Min(1800, [int]$binding.Config.longRequestTimeoutSeconds))
        $statusAction = {
            param($Event)
            Write-WorkerProgress -Event $Event
        }.GetNewClosure()
        $result = Invoke-AbbControllerBackup `
            -Session $binding.Session `
            -BackupName ([string]$plan.BackupName) `
            -LocalBackupPath ([string]$plan.LocalPath) `
            -ControllerIdentity $identity `
            -StateBefore $state `
            -Alias $alias `
            -Cell ([string]$plan.Cell) `
            -Robot ([string]$plan.Robot) `
            -Endpoint ([string]$identity.Endpoint) `
            -TimeoutSeconds ([int]$plan.TimeoutSeconds) `
            -RequestTimeoutSeconds $requestTimeout `
            -PollIntervalMilliseconds 500 `
            -HeartbeatSeconds 5 `
            -StatusAction $statusAction

        if (-not [bool]$result.Completed) {
            throw 'ABB controller backup did not report completion.'
        }
        if ([bool]$result.RobotStarted -or [bool]$result.MotorsEnabled) {
            throw 'ABB backup safety invariant failed: the backup path must never start RAPID or enable motors.'
        }

        $manifestPath = Resolve-AllowedLocalFile -Path ([string]$result.ManifestPath) -Extensions @('.json')
        $manifestSha256 = Get-Sha256File -Path $manifestPath
        if (-not [string]::Equals(
                [string]$result.ManifestSha256,
                [string]$manifestSha256,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'ABB backup manifest changed immediately after creation.'
        }

        $remoteBefore = ConvertTo-AbbBackupRemoteView -Snapshot $result.RemoteBefore -DefaultExists $true -Files @($result.Files)
        $remoteAfter = ConvertTo-AbbBackupRemoteView -Snapshot $result.RemoteAfter -DefaultExists $true -Files @($result.Files)
        return [pscustomobject][ordered]@{
            Applied            = $true
            Controller         = $alias
            Identity           = $identity
            BackupName         = [string]$plan.BackupName
            Cell               = [string]$plan.Cell
            Robot              = [string]$plan.Robot
            RemotePath         = [string]$result.RemotePath
            LocalPath          = [string]$result.LocalPath
            ManifestPath       = $manifestPath
            ManifestSha256     = $manifestSha256
            FileCount          = [int]$result.FileCount
            TotalBytes         = [long]$result.TotalBytes
            Safety             = $safety
            PreflightSessionReused = $sessionWasOpen
            RemoteBefore       = $remoteBefore
            RemoteAfter        = $remoteAfter
            RobotStarted       = $false
            MotorsEnabled      = $false
            ControllerModified = [bool]$result.ControllerModified
        }
    }
    finally {
        $script:PreparedBackups.Remove($Token)
    }
}

function Verify-AbbBackupArtifact {
    param(
        [Parameter(Mandatory)]
        [string]$ManifestPath
    )

    $resolvedManifestPath = Resolve-AllowedLocalFile -Path $ManifestPath -Extensions @('.json')
    $manifestSha256 = Get-Sha256File -Path $resolvedManifestPath
    $manifest = Get-Content -LiteralPath $resolvedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 40
    if ([int](Get-AbbBackupValue -Object $manifest -Name 'version' -Default 0) -ne 2) {
        throw 'Unsupported ABB backup manifest version.'
    }

    $alias = [string](Get-AbbBackupValue -Object $manifest -Name 'alias' -Default '')
    $backupName = [string](Get-AbbBackupValue -Object $manifest -Name 'backupName' -Default '')
    $localBackupPath = [string](Get-AbbBackupValue -Object $manifest -Name 'localPath' -Default '')
    if ([string]::IsNullOrWhiteSpace($alias) -or
        [string]::IsNullOrWhiteSpace($backupName) -or
        [string]::IsNullOrWhiteSpace($localBackupPath)) {
        throw 'ABB backup manifest is missing alias, backupName, or localPath.'
    }

    $resolvedLocalPath = Resolve-AllowedLocalRoot -Path $localBackupPath -Registry $script:Registry
    if (-not [string]::Equals(
            [System.IO.Path]::GetDirectoryName($resolvedManifestPath).TrimEnd('\', '/'),
            [string]$resolvedLocalPath.TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'ABB backup manifest is not stored in its declared local backup directory.'
    }

    Close-ControllerBinding -Alias $alias
    $binding = New-ControllerBinding -Alias $alias -BypassCircuit
    $rawIdentity = $binding.Identity
    Assert-ExpectedIdentity -Identity $rawIdentity -Config $binding.Config
    $identity = ConvertTo-AbbBackupIdentity -Identity $rawIdentity -Binding $binding

    $manifestController = Get-AbbBackupValue -Object $manifest -Name 'controller'
    $manifestIdentity = [pscustomobject][ordered]@{
        Endpoint  = [string](Get-AbbBackupValue -Object $manifest -Name 'endpoint' -Default '')
        Name      = [string](Get-AbbBackupValue -Object $manifestController -Name 'name' -Default '')
        SystemId  = [string](Get-AbbBackupValue -Object $manifestController -Name 'systemId' -Default '')
        RobotWare = [string](Get-AbbBackupValue -Object $manifestController -Name 'robotWare' -Default '')
    }
    Assert-AbbBackupIdentityMatch -Expected $manifestIdentity -Actual $identity

    $state = Get-ControllerState -Binding $binding
    Assert-SafeStoppedState -State $state -AllowedControllerStates @('guardstop', 'motoroff')
    $safety = ConvertTo-AbbBackupSafety -State $state
    $timeoutSeconds = [Math]::Max(1, [Math]::Min(300, [int]$binding.Config.longRequestTimeoutSeconds))
    $verification = Test-AbbBackupManifest `
        -Manifest $manifest `
        -LocalBackupPath $resolvedLocalPath `
        -Session $binding.Session `
        -TimeoutSeconds $timeoutSeconds

    $errors = @(
        @(Get-AbbBackupValue -Object $verification -Name 'Errors' -Default @()) |
            ForEach-Object { [string]$_ }
    )
    $localMismatches = @()
    if (-not [bool](Get-AbbBackupValue -Object $verification -Name 'LocalVerified' -Default $false)) {
        $localMismatches = @(
            $errors | ForEach-Object {
                [pscustomobject][ordered]@{
                    Reason = 'LocalBackupVerificationFailed'
                    Detail = $_
                }
            }
        )
        if ($localMismatches.Count -eq 0) {
            $localMismatches = @([pscustomobject]@{
                    Reason = 'LocalBackupVerificationFailed'
                    Detail = 'Local backup verification failed without a detailed error.'
                })
        }
    }
    $remoteMismatches = @()
    if (-not [bool](Get-AbbBackupValue -Object $verification -Name 'RemoteVerified' -Default $false)) {
        $remoteMismatches = @(
            $errors | ForEach-Object {
                [pscustomobject][ordered]@{
                    Reason = 'RemoteBackupVerificationFailed'
                    Detail = $_
                }
            }
        )
        if ($remoteMismatches.Count -eq 0) {
            $remoteMismatches = @([pscustomobject]@{
                    Reason = 'RemoteBackupVerificationFailed'
                    Detail = 'Remote backup verification failed without a detailed error.'
                })
        }
    }

    $localVerification = Get-AbbBackupValue -Object $manifest -Name 'localVerification'
    $manifestFiles = @(Get-AbbBackupValue -Object $manifest -Name 'files' -Default @())
    $expectedRemoteBytes = [long]((
            $manifestFiles |
                ForEach-Object { [long](Get-AbbBackupValue -Object $_ -Name 'RemoteSize' -Default (Get-AbbBackupValue -Object $_ -Name 'Size' -Default 0)) } |
                Measure-Object -Sum
        ).Sum)
    $verified = [bool](Get-AbbBackupValue -Object $verification -Name 'Valid' -Default $false) -and
        [bool](Get-AbbBackupValue -Object $verification -Name 'LocalVerified' -Default $false) -and
        [bool](Get-AbbBackupValue -Object $verification -Name 'RemoteVerified' -Default $false)

    return [pscustomobject][ordered]@{
        Verified             = $verified
        Controller           = $alias
        Identity             = $identity
        BackupName           = $backupName
        ManifestPath         = $resolvedManifestPath
        ManifestSha256       = $manifestSha256
        FileCount            = [int](Get-AbbBackupValue -Object $localVerification -Name 'fileCount' -Default $manifestFiles.Count)
        TotalBytes           = [long](Get-AbbBackupValue -Object $localVerification -Name 'totalBytes' -Default 0)
        RemoteFileCount      = [int](Get-AbbBackupValue -Object $verification -Name 'RemoteFileCount' -Default $manifestFiles.Count)
        RemoteTotalBytes     = [long](Get-AbbBackupValue -Object $verification -Name 'RemoteTotalBytes' -Default $expectedRemoteBytes)
        LocalHashMismatches  = $localMismatches
        RemoteMismatches     = $remoteMismatches
        Safety               = $safety
        FreshSession         = $true
        ControllerModified   = $false
    }
}

function Invoke-WorkerMethod {
    param([Parameter(Mandatory = $true)][string]$Method,[object]$Params)
    $registryReloaded = if ($Method -eq 'health') { $false } else { Update-RegistryIfChanged }
    switch ($Method) {
        'health' {
            return [pscustomobject]@{ ok = $true; service = 'abb-local-worker'; version = '1.1.1'; powershell = $PSVersionTable.PSVersion.ToString(); pid = $PID }
        }
        'probe_controller' {
            $baseUrl = Get-RequiredNonEmptyString -Object $Params -Name 'baseUrl'
            $credentialAlias = Get-RequiredNonEmptyString -Object $Params -Name 'credentialAlias'
            $null = Assert-ControllerAliasValue -Value $credentialAlias -Label 'credentialAlias'
            $requestTimeoutSeconds = ConvertTo-StrictTimeoutSeconds `
                -Value (Get-ObjectProperty -Object $Params -Name 'requestTimeoutSeconds') `
                -Name 'requestTimeoutSeconds' `
                -Default 5 `
                -Minimum 1 `
                -Maximum 30
            return Invoke-ControllerIdentityProbe `
                -BaseUrl $baseUrl `
                -CredentialAlias $credentialAlias `
                -RequestTimeoutSeconds $requestTimeoutSeconds
        }
        'register_controller' {
            $started = [Diagnostics.Stopwatch]::StartNew()
            $alias = Get-RequiredNonEmptyString -Object $Params -Name 'alias'
            $null = Assert-ControllerAliasValue -Value $alias
            $baseUrl = Get-RequiredNonEmptyString -Object $Params -Name 'baseUrl'
            $expectedName = Get-RequiredNonEmptyString -Object $Params -Name 'expectedName'
            $expectedSystemId = Normalize-SystemId (Get-RequiredNonEmptyString -Object $Params -Name 'expectedSystemId')
            $expectedRobotWare = Get-RequiredNonEmptyString -Object $Params -Name 'expectedRobotWare'
            $credentialAlias = Get-RequiredNonEmptyString -Object $Params -Name 'credentialAlias'
            $null = Assert-ControllerAliasValue -Value $credentialAlias -Label 'credentialAlias'

            $defaultTask = Get-RequiredNonEmptyString -Object $Params -Name 'defaultTask'
            $ioNetwork = Get-RequiredNonEmptyString -Object $Params -Name 'ioNetwork'
            $ioDevice = Get-RequiredNonEmptyString -Object $Params -Name 'ioDevice'
            Assert-SafeIdentifier -Value $defaultTask -Label 'default RAPID task'

            $requestTimeoutSeconds = ConvertTo-StrictTimeoutSeconds `
                -Value (Get-ObjectProperty -Object $Params -Name 'requestTimeoutSeconds') `
                -Name 'requestTimeoutSeconds' `
                -Default 5 `
                -Minimum 1 `
                -Maximum 30
            $longRequestTimeoutSeconds = ConvertTo-StrictTimeoutSeconds `
                -Value (Get-ObjectProperty -Object $Params -Name 'longRequestTimeoutSeconds') `
                -Name 'longRequestTimeoutSeconds' `
                -Default 60 `
                -Minimum 5 `
                -Maximum 1800

            $credentialConfig = Get-ControllerConfig -Alias $credentialAlias
            $username = [string](Get-ObjectProperty -Object $credentialConfig -Name 'username' -Required)
            $credentialFile = [string](Get-ObjectProperty -Object $credentialConfig -Name 'credentialFile' -Required)
            if ([string]::IsNullOrWhiteSpace($username)) { throw "Registered credential alias '$credentialAlias' has an empty username." }
            if ([string]::IsNullOrWhiteSpace($credentialFile)) { throw "Registered credential alias '$credentialAlias' has an empty credentialFile." }

            $probe = Invoke-ControllerIdentityProbe `
                -BaseUrl $baseUrl `
                -CredentialAlias $credentialAlias `
                -RequestTimeoutSeconds $requestTimeoutSeconds `
                -CredentialConfig $credentialConfig
            if (-not [string]::Equals([string]$probe.Identity.Name, $expectedName, [StringComparison]::Ordinal) -or
                -not [string]::Equals((Normalize-SystemId ([string]$probe.Identity.SystemId)), $expectedSystemId, [StringComparison]::Ordinal) -or
                -not [string]::Equals([string]$probe.Identity.RobotWare, $expectedRobotWare, [StringComparison]::Ordinal)) {
                throw "CONTROLLER IDENTITY MISMATCH: actual=$($probe.Identity.Name)/$($probe.Identity.SystemId)/$($probe.Identity.RobotWare), expected=$expectedName/$expectedSystemId/$expectedRobotWare"
            }

            $entry = [pscustomobject]@{
                baseUrl = [string]$probe.Endpoint
                expectedName = $expectedName
                expectedSystemId = $expectedSystemId
                expectedRobotWare = $expectedRobotWare
                username = $username
                credentialFile = $credentialFile
                defaultTask = $defaultTask
                ioNetwork = $ioNetwork
                ioDevice = $ioDevice
                requestTimeoutSeconds = $requestTimeoutSeconds
                longRequestTimeoutSeconds = $longRequestTimeoutSeconds
            }
            Write-ControllerRegistryEntry `
                -Alias $alias `
                -Entry $entry `
                -CredentialAlias $credentialAlias `
                -ExpectedUsername $username `
                -ExpectedCredentialFile $credentialFile
            $started.Stop()

            return [pscustomobject]@{
                Registered = $true
                Alias = $alias
                CredentialAlias = $credentialAlias
                Endpoint = $probe.Endpoint
                Identity = $probe.Identity
                RequestTimeoutSeconds = $requestTimeoutSeconds
                LongRequestTimeoutSeconds = $longRequestTimeoutSeconds
                ProbeElapsedMs = $probe.ElapsedMs
                ElapsedMs = $started.ElapsedMilliseconds
                RegistryReloadOnNextCall = $true
                ControllerModified = $false
            }
        }
        'list_controllers' {
            return [pscustomobject]@{
                RegistryReloaded = $registryReloaded
                Controllers = @($script:Registry.controllers.PSObject.Properties | ForEach-Object {
                    [pscustomobject]@{ Alias = $_.Name; Endpoint = [string]$_.Value.baseUrl; ExpectedName = [string]$_.Value.expectedName; ExpectedSystemId = Normalize-SystemId ([string]$_.Value.expectedSystemId); RobotWare = [string]$_.Value.expectedRobotWare }
                })
            }
        }
        'bind' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $alreadyBound = $script:Bindings.ContainsKey($alias)
            $binding = Get-ControllerBinding -Alias $alias
            # Repeated bind calls inside one unchanged worker/session are
            # read-only routing, not a controller-write preflight. Reuse a
            # recently verified identity; plan/apply/verify never use this path.
            $identityRead = if ($alreadyBound) {
                Get-BindingIdentityForRead -Binding $binding -MaxAgeSeconds 30
            } else {
                [pscustomobject]@{
                    Identity = $binding.Identity
                    CacheHit = $false
                    AgeMs = 0
                }
            }
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{
                Bound = $true; Alias = $alias; Endpoint = [string]$binding.Config.baseUrl
                Identity = $identityRead.Identity; BoundAt = $binding.BoundAt; VerifiedAt = $binding.VerifiedAt
                IdentityCacheHit = [bool]$identityRead.CacheHit
                IdentityAgeMs = [long]$identityRead.AgeMs
                ReusedSession = ($after.SessionCreateCount - $before.SessionCreateCount -eq 0)
                RegistryReloaded = $registryReloaded; Metrics = $after
                RequestDelta = $after.RequestCount - $before.RequestCount
                SessionCreateDelta = $after.SessionCreateCount - $before.SessionCreateCount
                ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount
                ElapsedMs = $started.ElapsedMilliseconds
            }
        }
        'disconnect' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            Close-ControllerBinding -Alias $alias
            Clear-ControllerTransportFailure -Alias $alias
            return [pscustomobject]@{ Disconnected = $true; Alias = $alias }
        }
        'disconnect_idle' {
            $idleSecondsValue = Get-ObjectProperty -Object $Params -Name 'idleSeconds'
            $idleSeconds = if ($null -eq $idleSecondsValue) { 180 } else { [int]$idleSecondsValue }
            if ($idleSeconds -lt 30) {
                throw 'idleSeconds must be at least 30.'
            }

            $cutoffUtc = [DateTime]::UtcNow.AddSeconds(-$idleSeconds)
            $aliases = [System.Collections.Generic.List[string]]::new()
            foreach ($alias in @($script:Bindings.Keys)) {
                $binding = $script:Bindings[$alias]
                $lastUsedProperty = $binding.PSObject.Properties['LastUsedAtUtc']
                $lastUsedUtc = if ($null -eq $lastUsedProperty) {
                    [DateTime]::Parse([string]$binding.BoundAt).ToUniversalTime()
                } else {
                    ([DateTime]$lastUsedProperty.Value).ToUniversalTime()
                }
                if ($lastUsedUtc -gt $cutoffUtc) { continue }

                Close-ControllerBinding -Alias ([string]$alias)
                $aliases.Add([string]$alias)
            }
            return [pscustomobject]@{
                Disconnected = ($aliases.Count -gt 0)
                Count = $aliases.Count
                Aliases = $aliases.ToArray()
                IdleSeconds = $idleSeconds
                CheckedAtUtc = [DateTime]::UtcNow.ToString('o')
            }
        }
        'snapshot' {
            return Get-ControllerSnapshot -Alias ([string](Get-ObjectProperty -Object $Params -Name 'alias' -Required))
        }
        'read_signals' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $signals = @(Get-IoSignalsBulk -Binding $binding -Names @($Params.names | ForEach-Object { [string]$_ }))
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{ Alias = $alias; Signals = $signals; Metrics = $after; RequestDelta = $after.RequestCount - $before.RequestCount; ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount; ElapsedMs = $started.ElapsedMilliseconds }
        }
        'list_modules' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $task = [string](Get-ObjectProperty -Object $Params -Name 'task' -Required)
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $modules = @(Get-RapidModules -Binding $binding -Task $task)
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{ Alias = $alias; Task = $task; Modules = $modules; Metrics = $after; RequestDelta = $after.RequestCount - $before.RequestCount; ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount; ElapsedMs = $started.ElapsedMilliseconds }
        }
        'list_io_signal_config' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $prefix = [string](Get-ObjectProperty -Object $Params -Name 'prefix')
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $instances = @(Get-ConfigInstances -Binding $binding -Domain eio -Type 'EIO_SIGNAL')
            if (-not [string]::IsNullOrEmpty($prefix)) {
                $instances = @($instances | Where-Object { ([string](Get-ObjectProperty -Object $_.Attributes -Name 'Name')).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
            }
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{ Alias = $alias; Prefix = $prefix; Count = $instances.Count; Signals = $instances; Metrics = $after; RequestDelta = $after.RequestCount - $before.RequestCount; ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount; ElapsedMs = $started.ElapsedMilliseconds }
        }
        'list_config_instances' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $Params -Name 'domain' -Required))
            $type = [string](Get-ObjectProperty -Object $Params -Name 'type' -Required)
            $filterAttribute = [string](Get-ObjectProperty -Object $Params -Name 'filterAttribute')
            $prefix = [string](Get-ObjectProperty -Object $Params -Name 'prefix')
            Assert-SafeIdentifier -Value $type -Label 'configuration type'
            if (-not [string]::IsNullOrWhiteSpace($filterAttribute)) {
                Assert-SafeIdentifier -Value $filterAttribute -Label 'configuration filter attribute'
            } elseif (-not [string]::IsNullOrEmpty($prefix)) {
                throw 'prefix requires filterAttribute.'
            }
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $instances = @(Get-ConfigInstances -Binding $binding -Domain $domain -Type $type)
            if (-not [string]::IsNullOrWhiteSpace($filterAttribute)) {
                $instances = @($instances | Where-Object {
                    $value = [string](Get-ObjectProperty -Object $_.Attributes -Name $filterAttribute)
                    $value.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
                })
            }
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{
                Alias = $alias; Domain = $domain; Type = $type; FilterAttribute = $filterAttribute; Prefix = $prefix
                Count = $instances.Count; Instances = $instances; Metrics = $after
                RequestDelta = $after.RequestCount - $before.RequestCount
                ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount
                ElapsedMs = $started.ElapsedMilliseconds
            }
        }
        'read_config_instance' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $domain = Normalize-ConfigDomain -Domain ([string](Get-ObjectProperty -Object $Params -Name 'domain' -Required))
            $type = [string](Get-ObjectProperty -Object $Params -Name 'type' -Required)
            $instance = [string](Get-ObjectProperty -Object $Params -Name 'instance' -Required)
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $result = Get-ConfigInstance -Binding $binding -Domain $domain -Type $type -Instance $instance
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{
                Alias = $alias; Domain = $domain; Type = $type; Instance = $result
                Metrics = $after; RequestDelta = $after.RequestCount - $before.RequestCount
                ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount
                ElapsedMs = $started.ElapsedMilliseconds
            }
        }
        'read_module' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $task = [string](Get-ObjectProperty -Object $Params -Name 'task' -Required)
            $module = [string](Get-ObjectProperty -Object $Params -Name 'module' -Required)
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $text = Get-RapidModuleText -Binding $binding -Task $task -Module $module
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{ Alias = $alias; Task = $task; Module = $module; SourceSha256 = Get-Sha256Text -Text $text; Text = $text; Metrics = $after; RequestDelta = $after.RequestCount - $before.RequestCount; ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount; ElapsedMs = $started.ElapsedMilliseconds }
        }
        'read_rapid_data' {
            $alias = [string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)
            $task = [string](Get-ObjectProperty -Object $Params -Name 'task' -Required)
            $module = [string](Get-ObjectProperty -Object $Params -Name 'module' -Required)
            $name = [string](Get-ObjectProperty -Object $Params -Name 'name' -Required)
            Assert-SafeIdentifier -Value $task -Label 'RAPID task'
            Assert-SafeIdentifier -Value $module -Label 'RAPID module'
            Assert-SafeIdentifier -Value $name -Label 'RAPID data name'
            $started = [Diagnostics.Stopwatch]::StartNew()
            $before = Copy-AliasMetrics -Alias $alias
            $binding = Get-ControllerBinding -Alias $alias
            $value = Get-RapidDataValue -Binding $binding -Task $task -Module $module -Name $name
            $started.Stop()
            $after = Copy-AliasMetrics -Alias $alias
            return [pscustomobject]@{
                Alias = $alias; Task = $task; Module = $module; Name = $name; Value = $value
                Metrics = $after; RequestDelta = $after.RequestCount - $before.RequestCount
                ReconnectDelta = $after.ReconnectCount - $before.ReconnectCount
                ElapsedMs = $started.ElapsedMilliseconds
            }
        }
        'prepare_changeset' {
            return Prepare-AbbChangeset -Changeset (Get-ObjectProperty -Object $Params -Name 'changeset' -Required)
        }
        'commit_job' {
            return Invoke-AbbPreparedJob -Token ([string](Get-ObjectProperty -Object $Params -Name 'token' -Required))
        }
        'verify_changeset' {
            return Verify-AbbChangeset -Changeset (Get-ObjectProperty -Object $Params -Name 'changeset' -Required)
        }
        'plan_backup' {
            Import-AbbBackupLibrary
            $timeoutValue = Get-AbbBackupValue -Object $Params -Name 'timeoutSeconds' -Default 600
            return Plan-AbbBackup `
                -Alias ([string](Get-ObjectProperty -Object $Params -Name 'alias' -Required)) `
                -LocalRoot ([string](Get-ObjectProperty -Object $Params -Name 'localRoot' -Required)) `
                -BackupName ([string](Get-ObjectProperty -Object $Params -Name 'backupName' -Required)) `
                -Cell ([string](Get-AbbBackupValue -Object $Params -Name 'cell' -Default '')) `
                -Robot ([string](Get-AbbBackupValue -Object $Params -Name 'robot' -Default '')) `
                -TimeoutSeconds ([int]$timeoutValue)
        }
        'apply_backup' {
            Import-AbbBackupLibrary
            return Invoke-AbbBackupPlan -Token ([string](Get-ObjectProperty -Object $Params -Name 'token' -Required))
        }
        'verify_backup' {
            Import-AbbBackupLibrary
            return Verify-AbbBackupArtifact -ManifestPath ([string](Get-ObjectProperty -Object $Params -Name 'manifestPath' -Required))
        }
        default { throw "Unknown worker method: $Method" }
    }
}

function Write-WorkerResponse {
    param([Parameter(Mandatory = $true)][object]$Response)
    $json = $Response | ConvertTo-Json -Depth 40 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Write-WorkerProgress {
    param([Parameter(Mandatory = $true)][object]$Event)
    if ($null -eq $script:CurrentWorkerRequestId) { return }
    Write-WorkerResponse -Response ([pscustomobject]@{
        id = $script:CurrentWorkerRequestId
        progress = $true
        event = $Event
    })
}

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $request = $null
        try {
            $request = $line | ConvertFrom-Json
            $script:CurrentWorkerRequestId = $request.id
            $result = Invoke-WorkerMethod -Method ([string]$request.method) -Params $request.params
            Write-WorkerResponse -Response ([pscustomobject]@{ id = $request.id; ok = $true; result = $result })
        }
        catch {
            $requestId = if ($null -eq $request) { $null } else { $request.id }
            Write-WorkerResponse -Response ([pscustomobject]@{
                id = $requestId
                ok = $false
                error = [pscustomobject]@{ type = $_.Exception.GetType().FullName; message = $_.Exception.Message }
            })
        }
        finally {
            $script:CurrentWorkerRequestId = $null
        }
    }
}
finally {
    foreach ($alias in @($script:Bindings.Keys)) { Close-ControllerBinding -Alias $alias }
}
