#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Alias = '',
    [string]$LocalRoot = '',
    [string]$BackupName = '',
    [string]$Cell = '',
    [string]$Robot = '',
    [ValidateRange(30, 1800)][int]$TimeoutSeconds = 600,
    [ValidateRange(100, 5000)][int]$PollIntervalMilliseconds = 500,
    [ValidateRange(1, 60)][int]$HeartbeatSeconds = 5,
    [string]$RegistryPath = (Join-Path $PSScriptRoot 'controller-registry.json'),
    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($null -ne $PSStyle) {
    $PSStyle.OutputRendering = 'PlainText'
}

function Write-BackupEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [AllowEmptyString()][string]$Message = ''
    )
    $line = '{0} {1}{2}' -f
        (Get-Date).ToString('o'),
        $Phase,
        $(if ([string]::IsNullOrWhiteSpace($Message)) { '' } else { " $Message" })
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function New-BackupHeartbeat {
    param([Parameter(Mandatory = $true)][string]$Activity)
    $callback = {
        param($Event)
        if ($Event.Kind -eq 'request_retry') {
            Write-BackupEvent `
                -Phase 'HTTP_RETRY' `
                -Message "activity=$Activity attempt=$($Event.Attempt)/$($Event.MaxAttempts) reason=$($Event.Reason)"
            return
        }
        Write-BackupEvent `
            -Phase 'HEARTBEAT' `
            -Message "activity=$Activity kind=$($Event.Kind) elapsedMs=$($Event.ElapsedMilliseconds)"
    }
    return $callback.GetNewClosure()
}

function Get-PropertyValue {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Normalize-SystemId {
    param([AllowEmptyString()][string]$Value = '')
    return $Value.Trim().Trim('{}').ToLowerInvariant()
}

function Resolve-AllowedLocalRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Registry
    )
    $resolved = [IO.Path]::GetFullPath($Path)
    $allowed = $false
    foreach ($rootValue in @($Registry.allowedLocalRoots)) {
        $expanded = [Environment]::ExpandEnvironmentVariables([string]$rootValue)
        $root = [IO.Path]::GetFullPath($expanded).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        if ($resolved.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
            $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            $allowed = $true
            break
        }
    }
    if (-not $allowed) {
        throw "LocalRoot is outside registry allowedLocalRoots: $resolved"
    }
    return $resolved
}

function Get-ControllerIdentity {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 15,
        [ValidateRange(1, 5)][int]$MaxAttempts = 1,
        [scriptblock]$HeartbeatAction
    )
    $response = Invoke-AbbRwsRequest `
        -Session $Session `
        -Method GET `
        -Path '/rw/system?json=1' `
        -TimeoutSeconds $TimeoutSeconds `
        -MaxAttempts $MaxAttempts `
        -HeartbeatAction $HeartbeatAction `
        -HeartbeatMilliseconds ($HeartbeatSeconds * 1000)
    if ($response.StatusCode -ne 200) {
        throw "Controller identity read failed HTTP $($response.StatusCode): $($response.FlatBody)"
    }
    $item = @((($response.Body | ConvertFrom-Json)._embedded._state)) |
        Where-Object { [string](Get-PropertyValue -Object $_ -Name '_type') -eq 'sys-system-li' } |
        Select-Object -First 1
    if ($null -eq $item) { throw 'Controller identity response did not contain sys-system-li.' }
    $robotWare = [string](Get-PropertyValue -Object $item -Name 'rwversion')
    if ([string]::IsNullOrWhiteSpace($robotWare)) {
        $robotWare = [string](Get-PropertyValue -Object $item -Name 'rwversionname')
    }
    return [pscustomobject]@{
        Name = [string](Get-PropertyValue -Object $item -Name 'name')
        SystemId = Normalize-SystemId ([string](Get-PropertyValue -Object $item -Name 'sysid'))
        RobotWare = $robotWare
    }
}

function Get-ControllerSafetyState {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 15,
        [ValidateRange(1, 5)][int]$MaxAttempts = 1,
        [scriptblock]$HeartbeatAction
    )
    $requestArguments = @{
        Session = $Session
        Method = 'GET'
        TimeoutSeconds = $TimeoutSeconds
        MaxAttempts = $MaxAttempts
        HeartbeatAction = $HeartbeatAction
        HeartbeatMilliseconds = ($HeartbeatSeconds * 1000)
    }
    $opmodeResponse = Invoke-AbbRwsRequest @requestArguments -Path '/rw/panel/opmode?json=1'
    $ctrlStateResponse = Invoke-AbbRwsRequest @requestArguments -Path '/rw/panel/ctrlstate?json=1'
    $executionResponse = Invoke-AbbRwsRequest @requestArguments -Path '/rw/rapid/execution?json=1'
    foreach ($response in @($opmodeResponse, $ctrlStateResponse, $executionResponse)) {
        if ($response.StatusCode -ne 200) {
            throw "Controller safety-state read failed HTTP $($response.StatusCode): $($response.FlatBody)"
        }
    }
    return [pscustomobject]@{
        Opmode = [string](@((($opmodeResponse.Body | ConvertFrom-Json)._embedded._state))[0].opmode)
        ControllerState = [string](@((($ctrlStateResponse.Body | ConvertFrom-Json)._embedded._state))[0].ctrlstate)
        RapidState = [string](@((($executionResponse.Body | ConvertFrom-Json)._embedded._state))[0].ctrlexecstate)
    }
}

function ConvertTo-EncodedRemotePath {
    param([Parameter(Mandatory = $true)][string[]]$Segments)
    return (@($Segments | ForEach-Object { [Uri]::EscapeDataString([string]$_) }) -join '/')
}

function Add-AbbJsonQuery {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ($Path -match '(?:[?&])json=1(?:&|$)') { return $Path }
    if ($Path.Contains('?')) { return "${Path}&json=1" }
    return "${Path}?json=1"
}

function Assert-SafeRemotePathSegment {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowEmptyString()][string]$Parent = ''
    )
    if ([string]::IsNullOrWhiteSpace($Name) -or
        $Name -in @('.', '..') -or
        $Name.Contains('/') -or
        $Name.Contains('\') -or
        $Name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw "Unsafe remote file-service entry name '$Name' under '$Parent'."
    }
}

function Resolve-BackupLocalFilePath {
    param(
        [Parameter(Mandatory = $true)][string]$LocalBackupPath,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )
    $root = [IO.Path]::GetFullPath($LocalBackupPath).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $candidate = $root
    foreach ($segment in @($RelativePath -split '/')) {
        Assert-SafeRemotePathSegment -Name $segment -Parent $RelativePath
        $candidate = Join-Path $candidate $segment
    }
    $resolved = [IO.Path]::GetFullPath($candidate)
    if (-not $resolved.StartsWith(
        $root + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Remote path escapes local backup root: $RelativePath"
    }
    return $resolved
}

function Get-RemoteTreeShape {
    param([Parameter(Mandatory = $true)][object[]]$Files)
    return @($Files | ForEach-Object {
        $sizeText = if ($null -eq $_.Size) { '<unknown>' } else { [string]([long]$_.Size) }
        "$($_.RelativePath)|$sizeText"
    })
}

function Measure-RemoteTree {
    param([Parameter(Mandatory = $true)][object[]]$Files)
    $known = @($Files | Where-Object { $null -ne $_.Size })
    $knownBytes = if ($known.Count -eq 0) {
        [long]0
    } else {
        [long](($known | Measure-Object -Property Size -Sum).Sum)
    }
    return [pscustomobject]@{
        FileCount = $Files.Count
        KnownSizeCount = $known.Count
        KnownBytes = $knownBytes
        AllSizesKnown = ($known.Count -eq $Files.Count)
    }
}

function ConvertTo-AbbBackupResponse {
    param([Parameter(Mandatory = $true)][object]$Response)

    if ($Response -is [System.Net.Http.HttpResponseMessage]) {
        try {
            $body = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $headers = @{}
            foreach ($header in $Response.Headers) {
                $headers[[string]$header.Key] = [string]::Join(', ', @($header.Value))
            }
            foreach ($header in $Response.Content.Headers) {
                $headers[[string]$header.Key] = [string]::Join(', ', @($header.Value))
            }
            return [pscustomobject]@{
                StatusCode = [int]$Response.StatusCode
                IsSuccess = $Response.IsSuccessStatusCode
                Body = $body
                FlatBody = ConvertTo-AbbBackupFlatText $body
                Headers = $headers
                Location = if ($null -ne $Response.Headers.Location) {
                    [string]$Response.Headers.Location
                } else {
                    ''
                }
            }
        }
        finally {
            $Response.Dispose()
        }
    }

    foreach ($requiredProperty in @('StatusCode', 'Body')) {
        if ($null -eq $Response.PSObject.Properties[$requiredProperty]) {
            throw "RequestInvoker response is missing property '$requiredProperty'."
        }
    }
    $statusCode = [int]$Response.StatusCode
    return [pscustomobject]@{
        StatusCode = $statusCode
        IsSuccess = if ($null -ne $Response.PSObject.Properties['IsSuccess']) {
            [bool]$Response.IsSuccess
        } else {
            $statusCode -ge 200 -and $statusCode -le 299
        }
        Body = [string]$Response.Body
        FlatBody = if ($null -ne $Response.PSObject.Properties['FlatBody']) {
            [string]$Response.FlatBody
        } else {
            ConvertTo-AbbBackupFlatText ([string]$Response.Body)
        }
        Headers = if ($null -ne $Response.PSObject.Properties['Headers']) {
            $Response.Headers
        } else {
            @{}
        }
        Location = if ($null -ne $Response.PSObject.Properties['Location']) {
            [string]$Response.Location
        } else {
            ''
        }
    }
}

function Get-AbbRemainingTimeoutSeconds {
    param(
        [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc,
        [ValidateRange(1, 1800)][int]$MaximumSeconds,
        [Parameter(Mandatory = $true)][string]$Phase
    )
    if ($DeadlineUtc -eq [DateTime]::MaxValue) { return $MaximumSeconds }
    $remainingMilliseconds = ($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMilliseconds -le 0) {
        throw "Backup overall timeout expired during $Phase."
    }
    $remainingSeconds = [Math]::Max(1, [int][Math]::Ceiling($remainingMilliseconds / 1000))
    return [Math]::Min($MaximumSeconds, $remainingSeconds)
}

function Invoke-AbbBackupRequest {
    param(
        $Session,
        [scriptblock]$RequestInvoker,
        [ValidateSet('GET', 'POST', 'PUT', 'DELETE')][string]$Method = 'GET',
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Form,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [ValidateRange(1, 5)][int]$MaxAttempts = 1,
        [scriptblock]$HeartbeatAction,
        [DateTime]$DeadlineUtc = [DateTime]::MaxValue
    )
    if ($null -eq $RequestInvoker -and $null -eq $Session) {
        throw 'Session or RequestInvoker is required.'
    }
    if ($MaxAttempts -gt 1 -and $Method -ne 'GET') {
        throw "Automatic retries are limited to GET: $Method $Path"
    }

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $effectiveTimeout = Get-AbbRemainingTimeoutSeconds `
            -DeadlineUtc $DeadlineUtc `
            -MaximumSeconds $TimeoutSeconds `
            -Phase "$Method $Path attempt $attempt"
        try {
            $raw = if ($null -ne $RequestInvoker) {
                & $RequestInvoker `
                    -Method $Method `
                    -Path $Path `
                    -Form $Form `
                    -TimeoutSeconds $effectiveTimeout `
                    -HeartbeatAction $HeartbeatAction
            } else {
                Invoke-AbbRwsRequest `
                    -Session $Session `
                    -Method $Method `
                    -Path $Path `
                    -Form $Form `
                    -TimeoutSeconds $effectiveTimeout `
                    -MaxAttempts 1 `
                    -HeartbeatAction $HeartbeatAction `
                    -HeartbeatMilliseconds ($HeartbeatSeconds * 1000)
            }
            $response = ConvertTo-AbbBackupResponse -Response $raw
            if ($attempt -lt $MaxAttempts -and
                $response.StatusCode -in @(408, 429, 500, 502, 503, 504)) {
                Invoke-BackupCallback -Action $HeartbeatAction -Event ([pscustomobject]@{
                    Kind = 'request_retry'
                    Attempt = $attempt
                    MaxAttempts = $MaxAttempts
                    Reason = "HTTP $($response.StatusCode)"
                    ElapsedMilliseconds = 0
                })
                Start-Sleep -Milliseconds 250
                continue
            }
            return $response
        }
        catch {
            if ($attempt -ge $MaxAttempts) { throw }
            Invoke-BackupCallback -Action $HeartbeatAction -Event ([pscustomobject]@{
                Kind = 'request_retry'
                Attempt = $attempt
                MaxAttempts = $MaxAttempts
                Reason = $_.Exception.Message
                ElapsedMilliseconds = 0
            })
            Start-Sleep -Milliseconds 250
        }
    }
}

function Invoke-BackupCallback {
    param(
        [scriptblock]$Action,
        [Parameter(Mandatory = $true)][object]$Event
    )
    if ($null -ne $Action) {
        try { $null = & $Action $Event } catch { }
    }
}

function Invoke-AbbBackupFileDownload {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [ValidateRange(-1, [long]::MaxValue)][long]$ExpectedBytes = -1,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [scriptblock]$TransferProgressAction,
        [ValidateRange(100, 60000)][int]$HeartbeatMilliseconds = 5000
    )
    return Save-AbbRwsFile `
        -Session $Session `
        -Path $Path `
        -DestinationPath $DestinationPath `
        -ExpectedBytes $ExpectedBytes `
        -TimeoutSeconds $TimeoutSeconds `
        -TransferProgressAction $TransferProgressAction `
        -HeartbeatMilliseconds $HeartbeatMilliseconds
}

function Get-RemoteDirectoryEntries {
    param(
        $Session,
        [scriptblock]$RequestInvoker,
        [Parameter(Mandatory = $true)][string]$BackupName,
        [AllowEmptyString()][string]$RelativeDirectory = '',
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [ValidateRange(1, 5)][int]$MaxAttempts = 2,
        [scriptblock]$HeartbeatAction,
        [DateTime]$DeadlineUtc = [DateTime]::MaxValue
    )
    $segments = [System.Collections.Generic.List[string]]::new()
    $segments.Add($BackupName)
    foreach ($segment in @($RelativeDirectory -split '/' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $segments.Add($segment)
    }
    $encoded = ConvertTo-EncodedRemotePath -Segments $segments.ToArray()
    $nextPath = "/fileservice/`$SYSPAR/$encoded/?json=1"
    $visitedPages = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $entries = [System.Collections.Generic.List[object]]::new()
    while (-not [string]::IsNullOrWhiteSpace($nextPath)) {
        if (-not $visitedPages.Add($nextPath)) {
            throw "Remote directory pagination loop detected for '$RelativeDirectory': $nextPath"
        }
        if ($visitedPages.Count -gt 1000) {
            throw "Remote directory pagination exceeded 1000 pages for '$RelativeDirectory'."
        }

        $response = Invoke-AbbBackupRequest `
            -Session $Session `
            -RequestInvoker $RequestInvoker `
            -Method GET `
            -Path $nextPath `
            -TimeoutSeconds $TimeoutSeconds `
            -MaxAttempts $MaxAttempts `
            -HeartbeatAction $HeartbeatAction `
            -DeadlineUtc $DeadlineUtc
        if ($response.StatusCode -ne 200) {
            throw "Remote directory read failed HTTP $($response.StatusCode) for $RelativeDirectory`: $($response.FlatBody)"
        }
        try {
            $document = $response.Body | ConvertFrom-Json
        }
        catch {
            throw "Remote directory returned invalid JSON for '$RelativeDirectory': $($_.Exception.Message)"
        }

        foreach ($item in @($document._embedded._state)) {
            $type = [string](Get-PropertyValue -Object $item -Name '_type')
            $name = [string](Get-PropertyValue -Object $item -Name '_title')
            if ([string]::IsNullOrWhiteSpace($name)) {
                $name = [string](Get-PropertyValue -Object $item -Name 'name')
            }
            if ([string]::IsNullOrWhiteSpace($name) -or $name -in @('.', '..')) { continue }

            $kind = if ($type -match '^fs-dir(?:-li)?$') {
                'directory'
            } elseif ($type -match '^fs-file(?:-li)?$') {
                'file'
            } else {
                continue
            }
            Assert-SafeRemotePathSegment -Name $name -Parent $RelativeDirectory

            $sizeValue = Get-PropertyValue -Object $item -Name 'fs-size'
            if ($null -eq $sizeValue) {
                $sizeValue = Get-PropertyValue -Object $item -Name 'size'
            }
            $size = $null
            if ($kind -eq 'file' -and
                $null -ne $sizeValue -and
                -not [string]::IsNullOrWhiteSpace([string]$sizeValue)) {
                $parsedSize = [long]0
                if (-not [long]::TryParse(
                    [string]$sizeValue,
                    [Globalization.NumberStyles]::Integer,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [ref]$parsedSize
                ) -or $parsedSize -lt 0) {
                    throw "Invalid remote file size '$sizeValue' for '$RelativeDirectory/$name'."
                }
                $size = $parsedSize
            }
            $entries.Add([pscustomobject]@{
                Name = $name
                Kind = $kind
                Size = $size
            })
        }

        $nextPath = ''
        $links = Get-PropertyValue -Object $document -Name '_links'
        if ($null -ne $links) {
            $nextLink = Get-PropertyValue -Object $links -Name 'next'
            if ($null -ne $nextLink) {
                $nextHref = [string](Get-PropertyValue -Object $nextLink -Name 'href')
                if (-not [string]::IsNullOrWhiteSpace($nextHref)) {
                    $nextPath = Add-AbbJsonQuery -Path $nextHref
                }
            }
        }
    }
    return $entries.ToArray()
}

function Get-RemoteBackupTree {
    param(
        $Session,
        [scriptblock]$RequestInvoker,
        [Parameter(Mandatory = $true)][string]$BackupName,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [ValidateRange(1, 5)][int]$MaxAttempts = 2,
        [scriptblock]$HeartbeatAction,
        [DateTime]$DeadlineUtc = [DateTime]::MaxValue
    )
    $directories = [System.Collections.Generic.Queue[string]]::new()
    $directories.Enqueue('')
    $seenDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $null = $seenDirectories.Add('')
    $seenEntries = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $files = [System.Collections.Generic.List[object]]::new()
    while ($directories.Count -gt 0) {
        $directory = $directories.Dequeue()
        foreach ($entry in @(Get-RemoteDirectoryEntries `
            -Session $Session `
            -RequestInvoker $RequestInvoker `
            -BackupName $BackupName `
            -RelativeDirectory $directory `
            -TimeoutSeconds $TimeoutSeconds `
            -MaxAttempts $MaxAttempts `
            -HeartbeatAction $HeartbeatAction `
            -DeadlineUtc $DeadlineUtc)) {
            $relative = if ([string]::IsNullOrWhiteSpace($directory)) {
                $entry.Name
            } else {
                "$directory/$($entry.Name)"
            }
            if (-not $seenEntries.Add($relative)) {
                throw "Duplicate remote backup path detected: $relative"
            }
            if ($entry.Kind -eq 'directory') {
                if (-not $seenDirectories.Add($relative)) {
                    throw "Remote directory cycle detected: $relative"
                }
                $directories.Enqueue($relative)
            } else {
                $files.Add([pscustomobject]@{
                    RelativePath = $relative
                    Size = $entry.Size
                })
            }
            if ($seenEntries.Count -gt 100000) {
                throw 'Remote backup tree exceeded the 100000-entry safety limit.'
            }
        }
        Invoke-BackupCallback -Action $HeartbeatAction -Event ([pscustomobject]@{
            Kind = 'tree_directory'
            Directory = $directory
            DirectoriesQueued = $directories.Count
            FilesFound = $files.Count
            ElapsedMilliseconds = 0
        })
    }
    return @($files.ToArray() | Sort-Object RelativePath)
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    try {
        return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function ConvertTo-AbbBackupFlatText {
    param([AllowEmptyString()][string]$Text = '')
    return (($Text -replace '<[^>]+>', ' ') -replace '\s+', ' ').Trim()
}

function Test-AbbCollisionResistantBackupName {
    param([Parameter(Mandatory = $true)][string]$BackupName)
    return $BackupName -match '(?i)_\d{8}_\d{6}_[0-9a-f]{8}$'
}

function Get-AbbRemoteBackupSnapshot {
    param(
        $Session,
        [scriptblock]$RequestInvoker,
        [Parameter(Mandatory = $true)][string]$BackupName,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [ValidateRange(1, 5)][int]$MaxAttempts = 2,
        [scriptblock]$HeartbeatAction,
        [DateTime]$DeadlineUtc = [DateTime]::MaxValue,
        [switch]$Shallow
    )
    if ($BackupName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$') {
        throw 'BackupName must contain only ASCII letters, digits, underscore, dot, or hyphen.'
    }
    $remotePath = '/fileservice/$SYSPAR/' + $BackupName
    $targetResponse = Invoke-AbbBackupRequest `
        -Session $Session `
        -RequestInvoker $RequestInvoker `
        -Method GET `
        -Path ($remotePath + '/?json=1') `
        -TimeoutSeconds $TimeoutSeconds `
        -MaxAttempts $MaxAttempts `
        -HeartbeatAction $HeartbeatAction `
        -DeadlineUtc $DeadlineUtc
    if ($targetResponse.StatusCode -eq 404) {
        return [pscustomobject]@{
            Exists = $false
            BackupName = $BackupName
            RemotePath = $remotePath
            FileCount = 0
            KnownSizeCount = 0
            KnownBytes = [long]0
            AllSizesKnown = $true
            TreeSha256 = Get-TextSha256 -Text ''
            Files = @()
        }
    }
    if ($targetResponse.StatusCode -ne 200) {
        throw "Remote backup target probe failed HTTP $($targetResponse.StatusCode): $($targetResponse.FlatBody)"
    }
    if ($Shallow) {
        return [pscustomobject]@{
            Exists = $true
            BackupName = $BackupName
            RemotePath = $remotePath
            FileCount = 0
            KnownSizeCount = 0
            KnownBytes = [long]0
            AllSizesKnown = $false
            TreeSha256 = ''
            TreeEnumerated = $false
            Files = @()
        }
    }

    $files = @(Get-RemoteBackupTree `
        -Session $Session `
        -RequestInvoker $RequestInvoker `
        -BackupName $BackupName `
        -TimeoutSeconds $TimeoutSeconds `
        -MaxAttempts $MaxAttempts `
        -HeartbeatAction $HeartbeatAction `
        -DeadlineUtc $DeadlineUtc)
    $stats = Measure-RemoteTree -Files $files
    $shape = Get-RemoteTreeShape -Files $files
    return [pscustomobject]@{
        Exists = $true
        BackupName = $BackupName
        RemotePath = $remotePath
        FileCount = $stats.FileCount
        KnownSizeCount = $stats.KnownSizeCount
        KnownBytes = $stats.KnownBytes
        AllSizesKnown = $stats.AllSizesKnown
        TreeSha256 = Get-TextSha256 -Text ($shape -join "`n")
        Files = $files
    }
}

function Test-AbbBackupManifest {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [string]$LocalBackupPath = '',
        $Session,
        [scriptblock]$RequestInvoker,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [switch]$SkipLocalHashes,
        [scriptblock]$HeartbeatAction
    )
    $manifestPath = ''
    $manifestObject = if ($Manifest -is [string]) {
        if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
            throw "Backup manifest not found: $Manifest"
        }
        $manifestPath = [IO.Path]::GetFullPath($Manifest)
        if ([string]::IsNullOrWhiteSpace($LocalBackupPath)) {
            $LocalBackupPath = Split-Path -Parent $manifestPath
        }
        Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
    } else {
        $Manifest
    }
    $errors = [System.Collections.Generic.List[string]]::new()
    $manifestFiles = @($manifestObject.files)
    $localVerified = $false
    $remoteVerified = $false
    $localFileCount = 0
    $localTotalBytes = [long]0
    $remoteFileCount = 0
    $remoteKnownBytes = [long]0
    $remoteAllSizesKnown = $false
    $manifestStructureValid = $true

    $manifestPathSet = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($file in $manifestFiles) {
        $relativePath = [string]$file.RelativePath
        if (-not $manifestPathSet.Add($relativePath)) {
            $errors.Add("Duplicate manifest file path: $relativePath")
            $manifestStructureValid = $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($LocalBackupPath)) {
        $localErrorStart = $errors.Count
        $resolvedLocalRoot = [IO.Path]::GetFullPath($LocalBackupPath)
        $expectedManifestPath = if (-not [string]::IsNullOrWhiteSpace($manifestPath)) {
            $manifestPath
        } else {
            Join-Path $resolvedLocalRoot 'backup_manifest.json'
        }
        $actualPathSet = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase
        )
        $actualLocalFiles = @(Get-ChildItem -LiteralPath $resolvedLocalRoot -File -Recurse)
        foreach ($actualFile in $actualLocalFiles) {
            if ($actualFile.FullName.Equals(
                $expectedManifestPath,
                [StringComparison]::OrdinalIgnoreCase
            )) {
                continue
            }
            $relative = [IO.Path]::GetRelativePath(
                $resolvedLocalRoot,
                $actualFile.FullName
            ).Replace([IO.Path]::DirectorySeparatorChar, '/')
            if (-not $actualPathSet.Add($relative)) {
                $errors.Add("Duplicate local backup path: $relative")
            }
            $localTotalBytes += [long]$actualFile.Length
        }
        $localFileCount = $actualPathSet.Count
        foreach ($extraPath in @($actualPathSet | Where-Object {
            -not $manifestPathSet.Contains($_)
        })) {
            $errors.Add("Unexpected local backup file: $extraPath")
        }
        foreach ($missingPath in @($manifestPathSet | Where-Object {
            -not $actualPathSet.Contains($_)
        })) {
            $errors.Add("Missing local backup file: $missingPath")
        }

        foreach ($file in $manifestFiles) {
            $relativePath = [string]$file.RelativePath
            try {
                $path = Resolve-BackupLocalFilePath `
                    -LocalBackupPath $LocalBackupPath `
                    -RelativePath $relativePath
            }
            catch {
                $errors.Add($_.Exception.Message)
                continue
            }
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                continue
            }
            $item = Get-Item -LiteralPath $path
            if ([long]$item.Length -ne [long]$file.Size) {
                $errors.Add("Local size mismatch for $relativePath`: actual=$($item.Length) manifest=$($file.Size)")
            }
            if (-not $SkipLocalHashes) {
                $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actualHash -cne ([string]$file.Sha256).ToLowerInvariant()) {
                    $errors.Add("Local SHA256 mismatch for $relativePath.")
                }
            }
        }
        $localVerified = (
            $manifestStructureValid -and
            $errors.Count -eq $localErrorStart
        )
    }

    if ($null -ne $Session -or $null -ne $RequestInvoker) {
        $snapshot = Get-AbbRemoteBackupSnapshot `
            -Session $Session `
            -RequestInvoker $RequestInvoker `
            -BackupName ([string]$manifestObject.backupName) `
            -TimeoutSeconds $TimeoutSeconds `
            -MaxAttempts 2 `
            -HeartbeatAction $HeartbeatAction
        if (-not $snapshot.Exists) {
            $errors.Add("Remote backup no longer exists: $($manifestObject.backupName)")
        } else {
            $remoteFileCount = $snapshot.FileCount
            $remoteKnownBytes = $snapshot.KnownBytes
            $remoteAllSizesKnown = $snapshot.AllSizesKnown
            $manifestRemoteFiles = @($manifestFiles | ForEach-Object {
                $remoteSize = if ($null -ne $_.PSObject.Properties['RemoteSize']) {
                    $_.RemoteSize
                } else {
                    $_.Size
                }
                [pscustomobject]@{
                    RelativePath = [string]$_.RelativePath
                    Size = $remoteSize
                }
            } | Sort-Object RelativePath)
            $manifestShape = Get-RemoteTreeShape -Files $manifestRemoteFiles
            $snapshotShape = Get-RemoteTreeShape -Files @($snapshot.Files)
            if (($manifestShape -join "`n") -cne ($snapshotShape -join "`n")) {
                $errors.Add('Remote backup tree does not match manifest.')
            } elseif ($manifestStructureValid) {
                $remoteVerified = $true
            }
        }
    }

    return [pscustomobject]@{
        Valid = ($errors.Count -eq 0)
        BackupName = [string]$manifestObject.backupName
        FileCount = $manifestFiles.Count
        LocalVerified = $localVerified
        LocalFileCount = $localFileCount
        LocalTotalBytes = $localTotalBytes
        RemoteVerified = $remoteVerified
        RemoteFileCount = $remoteFileCount
        RemoteKnownBytes = $remoteKnownBytes
        RemoteTotalBytes = if ($remoteAllSizesKnown) { $remoteKnownBytes } else { $null }
        RemoteAllSizesKnown = $remoteAllSizesKnown
        LocalErrors = @($errors | Where-Object {
            $_ -match '(?i)local|manifest file path'
        })
        RemoteErrors = @($errors | Where-Object {
            $_ -match '(?i)remote'
        })
        Errors = $errors.ToArray()
    }
}

function Get-ProgressState {
    param(
        $Session,
        [scriptblock]$RequestInvoker,
        [Parameter(Mandatory = $true)][string]$Location,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 30,
        [ValidateRange(1, 5)][int]$MaxAttempts = 2,
        [scriptblock]$HeartbeatAction,
        [DateTime]$DeadlineUtc = [DateTime]::MaxValue
    )
    $path = Add-AbbJsonQuery -Path $Location
    $response = Invoke-AbbBackupRequest `
        -Session $Session `
        -RequestInvoker $RequestInvoker `
        -Method GET `
        -Path $path `
        -TimeoutSeconds $TimeoutSeconds `
        -MaxAttempts $MaxAttempts `
        -HeartbeatAction $HeartbeatAction `
        -DeadlineUtc $DeadlineUtc
    if ($response.StatusCode -ne 200) {
        throw "Backup progress read failed HTTP $($response.StatusCode): $($response.FlatBody)"
    }
    $item = @((($response.Body | ConvertFrom-Json)._embedded._state)) | Select-Object -First 1
    if ($null -eq $item) { throw 'Backup progress response contained no state item.' }
    return [pscustomobject]@{
        State = ([string](Get-PropertyValue -Object $item -Name 'state')).Trim()
        Code = ([string](Get-PropertyValue -Object $item -Name 'code')).Trim()
    }
}

function Invoke-AbbControllerBackup {
    [CmdletBinding()]
    param(
        $Session,
        [scriptblock]$RequestInvoker,
        [scriptblock]$FileDownloader,
        [Parameter(Mandatory = $true)][string]$BackupName,
        [Parameter(Mandatory = $true)][string]$LocalBackupPath,
        [Parameter(Mandatory = $true)][object]$ControllerIdentity,
        [Parameter(Mandatory = $true)][object]$StateBefore,
        [string]$Alias = '',
        [string]$Cell = '',
        [string]$Robot = '',
        [string]$Endpoint = '',
        [ValidateRange(30, 1800)][int]$TimeoutSeconds = 600,
        [ValidateRange(1, 1800)][int]$RequestTimeoutSeconds = 60,
        [ValidateRange(100, 5000)][int]$PollIntervalMilliseconds = 500,
        [ValidateRange(1, 60)][int]$HeartbeatSeconds = 5,
        [scriptblock]$StatusAction
    )
    if ($null -eq $Session -and $null -eq $RequestInvoker) {
        throw 'Session or RequestInvoker is required.'
    }
    if ($null -eq $Session -and $null -eq $FileDownloader) {
        throw 'FileDownloader is required when Session is not supplied.'
    }
    if ($BackupName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$') {
        throw 'BackupName must contain only ASCII letters, digits, underscore, dot, or hyphen.'
    }
    $resolvedLocalBackupPath = [IO.Path]::GetFullPath($LocalBackupPath)
    if (Test-Path -LiteralPath $resolvedLocalBackupPath) {
        throw "Local backup target already exists: $resolvedLocalBackupPath"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

    $emit = {
        param(
            [Parameter(Mandatory = $true)][string]$Phase,
            [hashtable]$Data = @{}
        )
        Invoke-BackupCallback -Action $StatusAction -Event ([pscustomobject]@{
            Phase = $Phase
            At = (Get-Date).ToString('o')
            Data = [pscustomobject]$Data
        })
    }.GetNewClosure()
    $heartbeat = {
        param($Event)
        Invoke-BackupCallback -Action $StatusAction -Event ([pscustomobject]@{
            Phase = 'heartbeat'
            At = (Get-Date).ToString('o')
            Data = $Event
        })
    }.GetNewClosure()

    # RW6 can leave a GET for a non-existent FileService directory pending for
    # minutes. Collision-resistant run names are safe to create directly; the
    # POST remains authoritative and creation is verified immediately after it
    # completes. Fixed names retain the conservative existence probe.
    if (-not (Test-AbbCollisionResistantBackupName -BackupName $BackupName)) {
        $existing = Get-AbbRemoteBackupSnapshot `
            -Session $Session `
            -RequestInvoker $RequestInvoker `
            -BackupName $BackupName `
            -TimeoutSeconds $RequestTimeoutSeconds `
            -MaxAttempts 1 `
            -HeartbeatAction $heartbeat `
            -DeadlineUtc $deadline `
            -Shallow
        if ($existing.Exists) {
            throw "Remote backup target already exists: $($existing.RemotePath)"
        }
    }

    $remoteBackupPath = '/fileservice/$SYSPAR/' + $BackupName
    $backupResponse = Invoke-AbbBackupRequest `
        -Session $Session `
        -RequestInvoker $RequestInvoker `
        -Method POST `
        -Path '/ctrl/backup?action=backup' `
        -Form @{ backup = $remoteBackupPath; archive = 'FALSE' } `
        -TimeoutSeconds $RequestTimeoutSeconds `
        -MaxAttempts 1 `
        -HeartbeatAction $heartbeat `
        -DeadlineUtc $deadline
    if ($backupResponse.StatusCode -ne 202) {
        throw "Backup request failed HTTP $($backupResponse.StatusCode): $($backupResponse.FlatBody)"
    }
    if ([string]::IsNullOrWhiteSpace([string]$backupResponse.Location)) {
        throw 'Backup request returned HTTP 202 without a Location header.'
    }
    $null = & $emit 'backup_accepted' @{
        http = 202
        location = [string]$backupResponse.Location
        remotePath = $remoteBackupPath
    }

    $lastProgressState = ''
    $lastProgressCode = ''
    $lastProgressAt = [DateTime]::MinValue
    $backupCompleted = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $progress = Get-ProgressState `
            -Session $Session `
            -RequestInvoker $RequestInvoker `
            -Location ([string]$backupResponse.Location) `
            -TimeoutSeconds $RequestTimeoutSeconds `
            -MaxAttempts 2 `
            -HeartbeatAction $heartbeat `
            -DeadlineUtc $deadline
        $changed = (
            $progress.State -ne $lastProgressState -or
            $progress.Code -ne $lastProgressCode
        )
        $heartbeatDue = ((Get-Date) - $lastProgressAt).TotalSeconds -ge $HeartbeatSeconds
        if ($changed -or $heartbeatDue) {
            $lastProgressState = $progress.State
            $lastProgressCode = $progress.Code
            $lastProgressAt = Get-Date
            $null = & $emit 'backup_progress' @{
                state = $lastProgressState
                code = $lastProgressCode
            }
        }
        if ($progress.State -match '^(DONE|COMPLETED|SUCCESS|OK)$' -or
            $progress.Code -eq '294913') {
            $backupCompleted = $true
            break
        }
        if ($progress.State -match '(FAIL|ERROR|ABORT|CANCEL)' -or
            ($progress.Code -match '^-' -and $progress.Code -ne '-0')) {
            throw "Backup progress reported failure: state=$($progress.State) code=$($progress.Code)"
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    if (-not $backupCompleted) {
        throw "Backup progress timed out after $TimeoutSeconds seconds."
    }

    $remoteBefore = @(Get-RemoteBackupTree `
        -Session $Session `
        -RequestInvoker $RequestInvoker `
        -BackupName $BackupName `
        -TimeoutSeconds $RequestTimeoutSeconds `
        -MaxAttempts 2 `
        -HeartbeatAction $heartbeat `
        -DeadlineUtc $deadline)
    if ($remoteBefore.Count -eq 0) {
        throw 'Remote backup tree is empty after successful progress completion.'
    }
    $remoteBeforeStats = Measure-RemoteTree -Files $remoteBefore
    $null = New-Item -ItemType Directory -Path $resolvedLocalBackupPath -Force

    $downloaded = [System.Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($file in $remoteBefore) {
        $index++
        $encodedRelative = ConvertTo-EncodedRemotePath -Segments @($file.RelativePath -split '/')
        $remoteFilePath = "/fileservice/`$SYSPAR/$([Uri]::EscapeDataString($BackupName))/$encodedRelative"
        $localFilePath = Resolve-BackupLocalFilePath `
            -LocalBackupPath $resolvedLocalBackupPath `
            -RelativePath $file.RelativePath
        $expectedBytes = if ($null -eq $file.Size) { [long]-1 } else { [long]$file.Size }
        $downloadTimeout = Get-AbbRemainingTimeoutSeconds `
            -DeadlineUtc $deadline `
            -MaximumSeconds $RequestTimeoutSeconds `
            -Phase "download $($file.RelativePath)"
        $null = & $emit 'download_start' @{
            index = $index
            count = $remoteBefore.Count
            relativePath = $file.RelativePath
            expectedBytes = $expectedBytes
        }
        $downloadProgress = {
            param($Event)
            Invoke-BackupCallback -Action $StatusAction -Event ([pscustomobject]@{
                Phase = 'download_progress'
                At = (Get-Date).ToString('o')
                Data = [pscustomobject]@{
                    index = $index
                    count = $remoteBefore.Count
                    relativePath = $file.RelativePath
                    bytesTransferred = $Event.BytesTransferred
                    contentLength = $Event.ContentLength
                    elapsedMilliseconds = $Event.ElapsedMilliseconds
                }
            })
        }.GetNewClosure()

        $saved = if ($null -ne $FileDownloader) {
            & $FileDownloader `
                -Path $remoteFilePath `
                -DestinationPath $localFilePath `
                -ExpectedBytes $expectedBytes `
                -TimeoutSeconds $downloadTimeout `
                -TransferProgressAction $downloadProgress `
                -HeartbeatMilliseconds ($HeartbeatSeconds * 1000)
        } else {
            Invoke-AbbBackupFileDownload `
                -Session $Session `
                -Path $remoteFilePath `
                -DestinationPath $localFilePath `
                -ExpectedBytes $expectedBytes `
                -TimeoutSeconds $downloadTimeout `
                -TransferProgressAction $downloadProgress `
                -HeartbeatMilliseconds ($HeartbeatSeconds * 1000)
        }
        foreach ($property in @('Path', 'Bytes', 'Sha256')) {
            if ($null -eq $saved.PSObject.Properties[$property]) {
                throw "FileDownloader result is missing '$property' for $($file.RelativePath)."
            }
        }
        $downloaded.Add([pscustomobject]@{
            RelativePath = $file.RelativePath
            Size = [long]$saved.Bytes
            RemoteSize = $file.Size
            ContentLength = if ($null -ne $saved.PSObject.Properties['ContentLength']) {
                $saved.ContentLength
            } else {
                $null
            }
            Sha256 = ([string]$saved.Sha256).ToLowerInvariant()
        })
        $null = & $emit 'download_done' @{
            index = $index
            count = $remoteBefore.Count
            relativePath = $file.RelativePath
            bytes = [long]$saved.Bytes
            sha256 = ([string]$saved.Sha256).ToLowerInvariant()
        }
        $null = Get-AbbRemainingTimeoutSeconds `
            -DeadlineUtc $deadline `
            -MaximumSeconds $RequestTimeoutSeconds `
            -Phase "post-download verification for $($file.RelativePath)"
    }

    $remoteAfter = @(Get-RemoteBackupTree `
        -Session $Session `
        -RequestInvoker $RequestInvoker `
        -BackupName $BackupName `
        -TimeoutSeconds $RequestTimeoutSeconds `
        -MaxAttempts 2 `
        -HeartbeatAction $heartbeat `
        -DeadlineUtc $deadline)
    $beforeShape = Get-RemoteTreeShape -Files $remoteBefore
    $afterShape = Get-RemoteTreeShape -Files $remoteAfter
    if (($beforeShape -join "`n") -cne ($afterShape -join "`n")) {
        throw 'Remote backup tree changed between pre-download and post-download enumeration.'
    }
    $remoteAfterStats = Measure-RemoteTree -Files $remoteAfter
    $localFiles = @(Get-ChildItem -LiteralPath $resolvedLocalBackupPath -File -Recurse)
    $localBytes = if ($localFiles.Count -eq 0) {
        [long]0
    } else {
        [long](($localFiles | Measure-Object -Property Length -Sum).Sum)
    }
    $downloadedBytes = [long](($downloaded | Measure-Object -Property Size -Sum).Sum)
    if ($localFiles.Count -ne $remoteAfter.Count -or $localBytes -ne $downloadedBytes) {
        throw "Local backup totals do not match downloads: localFiles=$($localFiles.Count) remoteFiles=$($remoteAfter.Count) localBytes=$localBytes downloadedBytes=$downloadedBytes"
    }
    if ($remoteAfterStats.AllSizesKnown -and $localBytes -ne $remoteAfterStats.KnownBytes) {
        throw "Local backup bytes do not match complete remote size metadata: localBytes=$localBytes remoteBytes=$($remoteAfterStats.KnownBytes)"
    }

    $manifest = [ordered]@{
        version = 2
        createdAt = (Get-Date).ToString('o')
        cell = $Cell
        robot = $Robot
        alias = $Alias
        endpoint = $Endpoint
        controller = [ordered]@{
            name = [string]$ControllerIdentity.Name
            systemId = [string]$ControllerIdentity.SystemId
            robotWare = [string]$ControllerIdentity.RobotWare
        }
        stateBefore = $StateBefore
        backupName = $BackupName
        remotePath = $remoteBackupPath
        localPath = $resolvedLocalBackupPath
        progress = [ordered]@{
            location = [string]$backupResponse.Location
            finalState = $lastProgressState
            finalCode = $lastProgressCode
        }
        remoteBeforeDownload = [ordered]@{
            fileCount = $remoteBeforeStats.FileCount
            knownSizeCount = $remoteBeforeStats.KnownSizeCount
            knownBytes = $remoteBeforeStats.KnownBytes
            allSizesKnown = $remoteBeforeStats.AllSizesKnown
        }
        remoteAfterDownload = [ordered]@{
            fileCount = $remoteAfterStats.FileCount
            knownSizeCount = $remoteAfterStats.KnownSizeCount
            knownBytes = $remoteAfterStats.KnownBytes
            allSizesKnown = $remoteAfterStats.AllSizesKnown
        }
        localVerification = [ordered]@{
            fileCount = $localFiles.Count
            totalBytes = $localBytes
            matchesRemote = $true
            manifestExcludedFromTotals = $true
        }
        files = @($downloaded.ToArray() | Sort-Object RelativePath)
    }
    $manifestPath = Join-Path $resolvedLocalBackupPath 'backup_manifest.json'
    $manifestPartialPath = "$manifestPath.partial"
    [IO.File]::WriteAllText(
        $manifestPartialPath,
        ($manifest | ConvertTo-Json -Depth 10),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $manifestPartialPath -Destination $manifestPath
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestCheck = Test-AbbBackupManifest `
        -Manifest $manifestPath `
        -LocalBackupPath $resolvedLocalBackupPath
    if (-not $manifestCheck.Valid) {
        throw "Local manifest verification failed: $($manifestCheck.Errors -join ' | ')"
    }

    return [pscustomobject]@{
        Completed = $true
        RemotePath = $remoteBackupPath
        LocalPath = $resolvedLocalBackupPath
        FileCount = $localFiles.Count
        TotalBytes = $localBytes
        ManifestPath = $manifestPath
        ManifestSha256 = $manifestHash
        Progress = [pscustomobject]@{
            Location = [string]$backupResponse.Location
            FinalState = $lastProgressState
            FinalCode = $lastProgressCode
        }
        RemoteBefore = [pscustomobject]@{
            Exists = $true
            BackupName = $BackupName
            RemotePath = $remoteBackupPath
            FileCount = $remoteBeforeStats.FileCount
            KnownSizeCount = $remoteBeforeStats.KnownSizeCount
            KnownBytes = $remoteBeforeStats.KnownBytes
            AllSizesKnown = $remoteBeforeStats.AllSizesKnown
            TreeSha256 = Get-TextSha256 -Text ($beforeShape -join "`n")
            Files = $remoteBefore
        }
        RemoteAfter = [pscustomobject]@{
            Exists = $true
            BackupName = $BackupName
            RemotePath = $remoteBackupPath
            FileCount = $remoteAfterStats.FileCount
            KnownSizeCount = $remoteAfterStats.KnownSizeCount
            KnownBytes = $remoteAfterStats.KnownBytes
            AllSizesKnown = $remoteAfterStats.AllSizesKnown
            TreeSha256 = Get-TextSha256 -Text ($afterShape -join "`n")
            Files = $remoteAfter
        }
        Files = $downloaded.ToArray()
        ControllerModified = $true
        RobotStarted = $false
        MotorsEnabled = $false
    }
}

if ($LibraryOnly) {
    return
}
if ([string]::IsNullOrWhiteSpace($Alias)) {
    throw 'Alias is required unless -LibraryOnly is used.'
}
if ([string]::IsNullOrWhiteSpace($LocalRoot)) {
    throw 'LocalRoot is required unless -LibraryOnly is used.'
}

if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
    throw "Controller registry not found: $RegistryPath"
}
$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$aliasProperty = $registry.controllers.PSObject.Properties[$Alias]
if ($null -eq $aliasProperty) { throw "Unknown controller alias: $Alias" }
$config = $aliasProperty.Value
$resolvedLocalRoot = Resolve-AllowedLocalRoot -Path $LocalRoot -Registry $registry

if ([string]::IsNullOrWhiteSpace($BackupName)) {
    $BackupName = "backup_$($Alias)_$((Get-Date).ToString('yyyyMMdd_HHmmss'))"
}
if ($BackupName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$') {
    throw 'BackupName must contain only ASCII letters, digits, underscore, dot, or hyphen.'
}
$localBackupPath = Join-Path $resolvedLocalRoot $BackupName
if (Test-Path -LiteralPath $localBackupPath) {
    throw "Local backup target already exists: $localBackupPath"
}
Write-BackupEvent `
    -Phase 'START' `
    -Message "alias=$Alias backup=$BackupName localRoot=$resolvedLocalRoot timeoutSeconds=$TimeoutSeconds"

$credentialPath = [Environment]::ExpandEnvironmentVariables([string]$config.credentialFile)
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw "DPAPI credential file missing: $credentialPath"
}
$credential = Import-Clixml -LiteralPath $credentialPath
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw "Credential file is not a PSCredential: $credentialPath"
}
$helperPath = [Environment]::ExpandEnvironmentVariables([string]$registry.rwsHelperPath)
. $helperPath
$requestTimeoutSeconds = [Math]::Max(15, [int]$config.requestTimeoutSeconds)
$longRequestTimeoutSeconds = [Math]::Max(60, [int]$config.longRequestTimeoutSeconds)
$preflightHeartbeat = New-BackupHeartbeat -Activity 'controller-precheck'
$fileServiceHeartbeat = New-BackupHeartbeat -Activity 'fileservice'

$session = $null
try {
    Write-BackupEvent -Phase 'CONNECTING' -Message "endpoint=$([string]$config.baseUrl)"
    $session = New-AbbRwsSession `
        -BaseUrl ([string]$config.baseUrl) `
        -Username ([string]$config.username) `
        -Password $credential.GetNetworkCredential().Password `
        -RequestTimeoutSeconds $requestTimeoutSeconds

    $identity = Get-ControllerIdentity `
        -Session $session `
        -TimeoutSeconds $requestTimeoutSeconds `
        -MaxAttempts 1 `
        -HeartbeatAction $preflightHeartbeat
    $expectedSystemId = Normalize-SystemId ([string]$config.expectedSystemId)
    if ($identity.Name -ne [string]$config.expectedName -or
        $identity.SystemId -ne $expectedSystemId -or
        $identity.RobotWare -ne [string]$config.expectedRobotWare) {
        throw "CONTROLLER IDENTITY MISMATCH: actual=$($identity.Name)/$($identity.SystemId)/$($identity.RobotWare), expected=$($config.expectedName)/$expectedSystemId/$($config.expectedRobotWare)"
    }
    $state = Get-ControllerSafetyState `
        -Session $session `
        -TimeoutSeconds $requestTimeoutSeconds `
        -MaxAttempts 1 `
        -HeartbeatAction $preflightHeartbeat
    if ($state.RapidState -ne 'stopped') { throw "RAPID must be stopped for backup: $($state.RapidState)" }
    if ($state.ControllerState -notin @('guardstop', 'motoroff')) {
        throw "Controller must be guardstop or motoroff for backup: $($state.ControllerState)"
    }
    Write-BackupEvent `
        -Phase 'PRECHECK' `
        -Message "alias=$Alias controller=$($identity.Name) systemId=$($identity.SystemId) robotWare=$($identity.RobotWare) opmode=$($state.Opmode) controllerState=$($state.ControllerState) rapidState=$($state.RapidState)"

    $statusAction = {
        param($Event)
        $phase = ([string]$Event.Phase).ToUpperInvariant()
        $message = if ($null -eq $Event.Data) {
            ''
        } else {
            $Event.Data | ConvertTo-Json -Depth 5 -Compress
        }
        Write-BackupEvent -Phase $phase -Message $message
    }.GetNewClosure()
    $backupCore = Invoke-AbbControllerBackup `
        -Session $session `
        -BackupName $BackupName `
        -LocalBackupPath $localBackupPath `
        -ControllerIdentity $identity `
        -StateBefore $state `
        -Alias $Alias `
        -Cell $Cell `
        -Robot $Robot `
        -Endpoint ([string]$config.baseUrl) `
        -TimeoutSeconds $TimeoutSeconds `
        -RequestTimeoutSeconds $longRequestTimeoutSeconds `
        -PollIntervalMilliseconds $PollIntervalMilliseconds `
        -HeartbeatSeconds $HeartbeatSeconds `
        -StatusAction $statusAction

    Close-AbbRwsSession -Session $session
    $session = $null
    $verifySession = New-AbbRwsSession `
        -BaseUrl ([string]$config.baseUrl) `
        -Username ([string]$config.username) `
        -Password $credential.GetNetworkCredential().Password `
        -RequestTimeoutSeconds $requestTimeoutSeconds
    $verifyIdentity = Get-ControllerIdentity `
        -Session $verifySession `
        -TimeoutSeconds $requestTimeoutSeconds `
        -MaxAttempts 1 `
        -HeartbeatAction $preflightHeartbeat
    if ($verifyIdentity.Name -ne $identity.Name -or
        $verifyIdentity.SystemId -ne $identity.SystemId -or
        $verifyIdentity.RobotWare -ne $identity.RobotWare) {
        throw 'Fresh-session identity verification failed after backup download.'
    }
    $manifestObject = Get-Content -LiteralPath $backupCore.ManifestPath -Raw | ConvertFrom-Json
    $freshVerification = Test-AbbBackupManifest `
        -Manifest $manifestObject `
        -Session $verifySession `
        -TimeoutSeconds $longRequestTimeoutSeconds `
        -HeartbeatAction $fileServiceHeartbeat
    if (-not $freshVerification.Valid -or -not $freshVerification.RemoteVerified) {
        throw "Fresh-session remote backup verification failed: $($freshVerification.Errors -join ' | ')"
    }
    Close-AbbRwsSession -Session $verifySession
    $verifySession = $null

    $result = [pscustomobject]@{
        Completed = $true
        Alias = $Alias
        Controller = $identity
        Cell = $Cell
        Robot = $Robot
        RemotePath = $backupCore.RemotePath
        LocalPath = $backupCore.LocalPath
        FileCount = $backupCore.FileCount
        TotalBytes = $backupCore.TotalBytes
        ManifestPath = $backupCore.ManifestPath
        ManifestSha256 = $backupCore.ManifestSha256
        FreshSessionVerified = $true
        ControllerModified = $true
        RobotStarted = $false
        MotorsEnabled = $false
    }
    Write-BackupEvent `
        -Phase 'COMPLETED' `
        -Message "controller=$($identity.Name) files=$($backupCore.FileCount) bytes=$($backupCore.TotalBytes) freshSessionVerified=true"
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
    [Console]::Out.Flush()
}
catch {
    Write-BackupEvent `
        -Phase 'FAILED' `
        -Message "type=$($_.Exception.GetType().FullName) message=$($_.Exception.Message)"
    throw
}
finally {
    if ($null -ne $session) { Close-AbbRwsSession -Session $session }
    if (Get-Variable -Name verifySession -ErrorAction SilentlyContinue) {
        if ($null -ne $verifySession) { Close-AbbRwsSession -Session $verifySession }
    }
}
