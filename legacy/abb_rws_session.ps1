#requires -Version 7.0
Set-StrictMode -Version Latest

function ConvertTo-AbbFlatText {
    param([Parameter(Mandatory = $true)][string]$Text)
    return (($Text -replace '<[^>]+>', ' ') -replace '\s+', ' ').Trim()
}

function New-AbbRwsSession {
    param(
        [string]$BaseUrl = 'http://192.0.2.20',
        [string]$Username = 'Default User',
        [string]$Password = $env:ABB_RWS_PASSWORD,
        [ValidateRange(1, 1800)][int]$RequestTimeoutSeconds = 20,
        [ValidateRange(1, 60)][int]$ConnectTimeoutSeconds = 3
    )

    if ([string]::IsNullOrWhiteSpace($Password)) {
        throw 'ABB RWS password missing. Pass -Password or set ABB_RWS_PASSWORD in the process environment.'
    }

    $cookieContainer = [System.Net.CookieContainer]::new()
    # SocketsHttpHandler exposes an independent TCP connect timeout while still
    # supporting Digest credentials and CookieContainer on PowerShell 7/.NET.
    $handler = [System.Net.Http.SocketsHttpHandler]::new()
    $handler.CookieContainer = $cookieContainer
    $handler.UseCookies = $true
    $handler.PreAuthenticate = $false
    $handler.Credentials = [System.Net.NetworkCredential]::new($Username, $Password)
    $handler.ConnectTimeout = [TimeSpan]::FromSeconds($ConnectTimeoutSeconds)
    $handler.PooledConnectionIdleTimeout = [TimeSpan]::FromSeconds(30)
    $handler.PooledConnectionLifetime = [TimeSpan]::FromMinutes(5)
    $handler.MaxConnectionsPerServer = 4

    $client = [System.Net.Http.HttpClient]::new($handler)
    # Use a per-request cancellation token below. A single global timeout makes
    # fast identity/config reads wait as long as uploads, builds, or CFG loads.
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('Codex-AbbRwsSession/1.0')
    $client.DefaultRequestHeaders.ExpectContinue = $false

    return [pscustomobject]@{
        BaseUrl = $BaseUrl.TrimEnd('/')
        Client = $client
        Handler = $handler
        Cookies = $cookieContainer
        Username = $Username
        DefaultTimeoutSeconds = $RequestTimeoutSeconds
        ConnectTimeoutSeconds = $ConnectTimeoutSeconds
    }
}

function Close-AbbRwsSession {
    param([Parameter(Mandatory = $true)]$Session)
    if ($Session.Client) {
        $Session.Client.Dispose()
    }
    if ($Session.Handler) {
        $Session.Handler.Dispose()
    }
}

function Wait-AbbTask {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [scriptblock]$HeartbeatAction,
        [ValidateRange(100, 60000)][int]$HeartbeatMilliseconds = 5000
    )

    while (-not $Task.IsCompleted) {
        try {
            $null = $Task.Wait($HeartbeatMilliseconds)
        }
        catch [AggregateException] {
            break
        }
        if (-not $Task.IsCompleted -and $null -ne $HeartbeatAction) {
            try { $null = & $HeartbeatAction } catch { }
        }
    }
    return $Task.GetAwaiter().GetResult()
}

function Invoke-AbbProgressAction {
    param(
        [scriptblock]$Action,
        [Parameter(Mandatory = $true)][object]$Event
    )
    if ($null -ne $Action) {
        try { $null = & $Action $Event } catch { }
    }
}

function Invoke-AbbRwsRequest {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
        [string]$Method = 'GET',
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Form,
        [byte[]]$Bytes,
        [string]$ContentType = 'application/x-www-form-urlencoded',
        [ValidateRange(0, 1800)][int]$TimeoutSeconds = 0,
        [ValidateRange(1, 5)][int]$MaxAttempts = 1,
        [ValidateRange(0, 10000)][int]$RetryDelayMilliseconds = 250,
        [scriptblock]$HeartbeatAction,
        [ValidateRange(100, 60000)][int]$HeartbeatMilliseconds = 5000
    )

    $uri = if ($Path.StartsWith('http', [StringComparison]::OrdinalIgnoreCase)) {
        [Uri]$Path
    } else {
        [Uri]($Session.BaseUrl + $Path)
    }

    if ($MaxAttempts -gt 1 -and $Method -ne 'GET') {
        throw "Automatic retries are limited to idempotent GET requests: $Method $uri"
    }

    $effectiveTimeout = if ($TimeoutSeconds -gt 0) {
        $TimeoutSeconds
    } elseif ($null -ne $Session.PSObject.Properties['DefaultTimeoutSeconds']) {
        [int]$Session.DefaultTimeoutSeconds
    } else {
        20
    }

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $uri)
        if ($null -ne $Form) {
            $pairs = [System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string,string]]]::new()
            foreach ($key in $Form.Keys) {
                $pairs.Add([System.Collections.Generic.KeyValuePair[string,string]]::new([string]$key, [string]$Form[$key]))
            }
            $request.Content = [System.Net.Http.FormUrlEncodedContent]::new($pairs)
        } elseif ($null -ne $Bytes) {
            $request.Content = [System.Net.Http.ByteArrayContent]::new($Bytes)
            $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType)
        }

        $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($effectiveTimeout))
        $response = $null
        $retryReason = ''
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $waitHeartbeat = {
            Invoke-AbbProgressAction -Action $HeartbeatAction -Event ([pscustomobject]@{
                Kind = 'request_wait'
                Method = $Method
                Uri = [string]$uri
                Attempt = $attempt
                ElapsedMilliseconds = [long]$stopwatch.ElapsedMilliseconds
            })
        }
        try {
            $sendTask = $Session.Client.SendAsync(
                $request,
                [System.Net.Http.HttpCompletionOption]::ResponseContentRead,
                $cancel.Token
            )
            $response = Wait-AbbTask `
                -Task $sendTask `
                -HeartbeatAction $waitHeartbeat `
                -HeartbeatMilliseconds $HeartbeatMilliseconds
            $body = $response.Content.ReadAsStringAsync($cancel.Token).GetAwaiter().GetResult()

            $headers = @{}
            foreach ($header in $response.Headers) {
                $headers[[string]$header.Key] = [string]::Join(', ', @($header.Value))
            }
            foreach ($header in $response.Content.Headers) {
                $headers[[string]$header.Key] = [string]::Join(', ', @($header.Value))
            }
            $statusCode = [int]$response.StatusCode
            if ($attempt -lt $MaxAttempts -and $statusCode -in @(408, 429, 500, 502, 503, 504)) {
                $retryReason = "HTTP $statusCode"
            } else {
                return [pscustomobject]@{
                    StatusCode = $statusCode
                    IsSuccess = $response.IsSuccessStatusCode
                    Body = $body
                    FlatBody = ConvertTo-AbbFlatText $body
                    Headers = $headers
                    Location = if ($null -ne $response.Headers.Location) { [string]$response.Headers.Location } else { '' }
                    Attempts = $attempt
                    ElapsedMilliseconds = [long]$stopwatch.ElapsedMilliseconds
                }
            }
        }
        catch [OperationCanceledException] {
            if ($attempt -ge $MaxAttempts) {
                throw [TimeoutException]::new(
                    "ABB RWS request timed out after $effectiveTimeout second(s), attempt $attempt/$MaxAttempts`: $Method $uri",
                    $_.Exception
                )
            }
            $retryReason = "timeout after $effectiveTimeout second(s)"
        }
        catch [System.Net.Http.HttpRequestException] {
            if ($attempt -ge $MaxAttempts) { throw }
            $retryReason = $_.Exception.Message
        }
        finally {
            $stopwatch.Stop()
            if ($null -ne $response) { $response.Dispose() }
            $cancel.Dispose()
            $request.Dispose()
        }

        Invoke-AbbProgressAction -Action $HeartbeatAction -Event ([pscustomobject]@{
            Kind = 'request_retry'
            Method = $Method
            Uri = [string]$uri
            Attempt = $attempt
            MaxAttempts = $MaxAttempts
            Reason = $retryReason
        })
        if ($RetryDelayMilliseconds -gt 0) {
            Start-Sleep -Milliseconds $RetryDelayMilliseconds
        }
    }
}

function Save-AbbRwsFile {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
        [ValidateRange(-1, [long]::MaxValue)][long]$ExpectedBytes = -1,
        [ValidateRange(4096, 1048576)][int]$BufferSize = 131072,
        [scriptblock]$TransferProgressAction,
        [ValidateRange(100, 60000)][int]$HeartbeatMilliseconds = 5000
    )

    $uri = if ($Path.StartsWith('http', [StringComparison]::OrdinalIgnoreCase)) {
        [Uri]$Path
    } else {
        [Uri]($Session.BaseUrl + $Path)
    }
    $resolvedDestination = [IO.Path]::GetFullPath($DestinationPath)
    $parent = Split-Path -Parent $resolvedDestination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $parent -Force
    }
    if (Test-Path -LiteralPath $resolvedDestination) {
        throw "Destination file already exists: $resolvedDestination"
    }
    $partial = "$resolvedDestination.partial"
    if (Test-Path -LiteralPath $partial) {
        throw "Partial destination already exists: $partial"
    }

    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $uri)
    $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    $response = $null
    $inputStream = $null
    $outputStream = $null
    $hasher = $null
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $bytesWritten = [long]0
    $contentLength = $null
    $waitHeartbeat = {
        Invoke-AbbProgressAction -Action $TransferProgressAction -Event ([pscustomobject]@{
            Kind = 'download_wait'
            Path = $Path
            DestinationPath = $resolvedDestination
            BytesTransferred = $bytesWritten
            ContentLength = $contentLength
            ElapsedMilliseconds = [long]$stopwatch.ElapsedMilliseconds
        })
    }
    try {
        $sendTask = $Session.Client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $cancel.Token
        )
        $response = Wait-AbbTask `
            -Task $sendTask `
            -HeartbeatAction $waitHeartbeat `
            -HeartbeatMilliseconds $HeartbeatMilliseconds
        if (-not $response.IsSuccessStatusCode) {
            $body = $response.Content.ReadAsStringAsync($cancel.Token).GetAwaiter().GetResult()
            throw "ABB RWS file download failed HTTP $([int]$response.StatusCode): $(ConvertTo-AbbFlatText $body)"
        }
        $contentLengthHeader = $response.Content.Headers.ContentLength
        if ($null -ne $contentLengthHeader) {
            $contentLength = [long]$contentLengthHeader
        }
        if ($ExpectedBytes -ge 0 -and $null -ne $contentLength -and $ExpectedBytes -ne $contentLength) {
            throw "ABB RWS file length header mismatch: expected=$ExpectedBytes contentLength=$contentLength path=$Path"
        }

        $inputStream = $response.Content.ReadAsStreamAsync($cancel.Token).GetAwaiter().GetResult()
        $outputStream = [IO.File]::Open(
            $partial,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        $hasher = [Security.Cryptography.IncrementalHash]::CreateHash(
            [Security.Cryptography.HashAlgorithmName]::SHA256
        )
        $buffer = [byte[]]::new($BufferSize)
        while ($true) {
            $readTask = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
            $read = Wait-AbbTask `
                -Task $readTask `
                -HeartbeatAction $waitHeartbeat `
                -HeartbeatMilliseconds $HeartbeatMilliseconds
            if ($read -eq 0) { break }
            $outputStream.Write($buffer, 0, $read)
            $hasher.AppendData($buffer, 0, $read)
            $bytesWritten += [long]$read
        }
        $outputStream.Flush($true)

        if ($null -ne $contentLength -and $bytesWritten -ne $contentLength) {
            throw "ABB RWS file download truncated: local=$bytesWritten contentLength=$contentLength path=$Path"
        }
        if ($ExpectedBytes -ge 0 -and $bytesWritten -ne $ExpectedBytes) {
            throw "ABB RWS file download size mismatch: local=$bytesWritten expected=$ExpectedBytes path=$Path"
        }
        $sha256 = [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant()

        $outputStream.Dispose()
        $outputStream = $null
        $inputStream.Dispose()
        $inputStream = $null
        Move-Item -LiteralPath $partial -Destination $resolvedDestination
        $item = Get-Item -LiteralPath $resolvedDestination
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Path = $resolvedDestination
            Bytes = $bytesWritten
            ContentLength = $contentLength
            Sha256 = $sha256
            ElapsedMilliseconds = [long]$stopwatch.ElapsedMilliseconds
        }
    }
    catch {
        if (Test-Path -LiteralPath $partial) {
            Remove-Item -LiteralPath $partial -Force
        }
        if ($_.Exception -is [OperationCanceledException]) {
            throw [TimeoutException]::new(
                "ABB RWS file download timed out after $TimeoutSeconds second(s): GET $uri",
                $_.Exception
            )
        }
        throw
    }
    finally {
        $stopwatch.Stop()
        if ($null -ne $hasher) { $hasher.Dispose() }
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $cancel.Dispose()
        $request.Dispose()
    }
}

function Test-AbbRwsConnection {
    param([Parameter(Mandatory = $true)]$Session)
    $opmode = Invoke-AbbRwsRequest -Session $Session -Method GET -Path '/rw/panel/opmode?json=1'
    $ctrlstate = Invoke-AbbRwsRequest -Session $Session -Method GET -Path '/rw/panel/ctrlstate?json=1'
    return [pscustomobject]@{
        OpmodeStatus = $opmode.StatusCode
        OpmodeBody = $opmode.Body
        CtrlStateStatus = $ctrlstate.StatusCode
        CtrlStateBody = $ctrlstate.Body
    }
}

function Get-AbbRapidData {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [string]$Task = 'T_ROB1',
        [Parameter(Mandatory = $true)][string]$Module,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $path = "/rw/rapid/symbol/data/RAPID/$Task/$Module/$Name`?json=1"
    $response = Invoke-AbbRwsRequest -Session $Session -Method GET -Path $path
    if (-not $response.IsSuccess) {
        throw "Read RAPID data failed HTTP $($response.StatusCode): $($response.FlatBody)"
    }

    $json = $response.Body | ConvertFrom-Json
    $data = @($json._embedded._state) | Where-Object { $_._type -eq 'rap-data' } | Select-Object -First 1
    $pos = @($json._embedded._state) | Where-Object { $_._type -eq 'rap-data-initval-pos' } | Select-Object -First 1
    return [pscustomobject]@{
        Task = $Task
        Module = $Module
        Name = $Name
        Value = [string]$data.value
        StartRow = if ($pos) { [int]$pos.'begin-row' } else { $null }
        StartCol = if ($pos) { [int]$pos.'begin-coloumn' } else { $null }
        EndRow = if ($pos) { [int]$pos.'end-row' } else { $null }
        EndCol = if ($pos) { [int]$pos.'end-coloumn' } else { $null }
    }
}

function Set-AbbRapidInitValue {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [string]$Task = 'T_ROB1',
        [Parameter(Mandatory = $true)][string]$Module,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value,
        [switch]$ConfirmWrite
    )

    if (-not $ConfirmWrite) {
        throw 'Write blocked. Pass -ConfirmWrite after local safety checks and explicit user approval.'
    }

    $path = "/rw/rapid/symbol/data/RAPID/$Task/$Module/$Name`?action=setInitValue"
    $response = Invoke-AbbRwsRequest -Session $Session -Method POST -Path $path -Form @{ value = $Value }
    if ($response.StatusCode -ne 204) {
        throw "setInitValue failed HTTP $($response.StatusCode): $($response.FlatBody)"
    }
    return $response
}

function Search-AbbRapidRobtargets {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [string]$Task = 'T_ROB1',
        [Parameter(Mandatory = $true)][string]$Module
    )

    $blockUrl = "RAPID/$Task/$Module"
    $response = Invoke-AbbRwsRequest -Session $Session -Method POST -Path '/rw/rapid/symbols?action=search-symbols' -Form @{
        blockurl = $blockUrl
        view = 'block'
        recursive = 'true'
    }
    if (-not $response.IsSuccess) {
        throw "Symbol search failed HTTP $($response.StatusCode): $($response.FlatBody)"
    }

    $items = [regex]::Matches($response.Body, '(?s)<li\s+class="rap-sympropconstant-li"[^>]*>(.*?)</li>')
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($item in $items) {
        $li = $item.Groups[1].Value
        if ($li -match '<span class="dattyp">\s*robtarget\s*</span>' -and
            $li -match '<span class="name">\s*([^<]+?)\s*</span>') {
            $names.Add([System.Net.WebUtility]::HtmlDecode($Matches[1]).Trim())
        }
    }
    return $names | Select-Object -Unique
}

function Get-AbbIndustrialNetwork {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [string]$Name = 'PROFINET'
    )

    $encoded = [Uri]::EscapeDataString($Name)
    $response = Invoke-AbbRwsRequest -Session $Session -Method GET -Path "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances/$encoded`?json=1"
    if (-not $response.IsSuccess) {
        throw "Read INDUSTRIAL_NETWORK failed HTTP $($response.StatusCode): $($response.FlatBody)"
    }
    return $response.Body | ConvertFrom-Json
}
