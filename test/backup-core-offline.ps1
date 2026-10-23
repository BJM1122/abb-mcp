#requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$toolRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent (Split-Path -Parent $toolRoot)
$helperPath = Join-Path $toolRoot 'legacy\abb_rws_session.ps1'
$backupLibraryPath = Join-Path $toolRoot 'backup-controller.ps1'
. $helperPath
. $backupLibraryPath -LibraryOnly

function Assert-BackupTest {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

if ($null -eq ('OfflineAbbHandler' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class OfflineAbbHandler : HttpMessageHandler
{
    public int RetryCalls { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        string path = request.RequestUri.AbsolutePath;
        if (path == "/slow")
        {
            await Task.Delay(750, cancellationToken);
            return Json(HttpStatusCode.OK, "{\"ok\":true}");
        }
        if (path == "/retry")
        {
            RetryCalls++;
            return RetryCalls == 1
                ? Json(HttpStatusCode.ServiceUnavailable, "{\"retry\":true}")
                : Json(HttpStatusCode.OK, "{\"retry\":false}");
        }
        if (path == "/binary")
        {
            byte[] bytes = new byte[4096];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = (byte)(i % 256);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(bytes)
            };
        }
        return Json(HttpStatusCode.OK, "{\"ok\":true}");
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body)
    {
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
    }
}
'@
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$testRoot = Join-Path $tempBase ("abb-backup-core-test-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot

try {
    $handler = [OfflineAbbHandler]::new()
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $fakeSession = [pscustomobject]@{
        BaseUrl = 'http://offline.invalid'
        Client = $client
        DefaultTimeoutSeconds = 2
    }

    $script:BackupHeartbeatCount = 0
    $heartbeat = {
        param($Event)
        $script:BackupHeartbeatCount++
    }
    $delayTask = [Threading.Tasks.Task]::Delay(350)
    $null = Wait-AbbTask `
        -Task $delayTask `
        -HeartbeatAction $heartbeat `
        -HeartbeatMilliseconds 100
    Assert-BackupTest `
        ($script:BackupHeartbeatCount -ge 1) `
        "slow task should emit a heartbeat (count=$script:BackupHeartbeatCount)"

    $retried = Invoke-AbbRwsRequest `
        -Session $fakeSession `
        -Method GET `
        -Path '/retry' `
        -TimeoutSeconds 2 `
        -MaxAttempts 2 `
        -RetryDelayMilliseconds 0
    Assert-BackupTest ($retried.StatusCode -eq 200) 'idempotent GET retry should recover'
    Assert-BackupTest ($retried.Attempts -eq 2) 'GET retry should report two attempts'

    $script:DeadlineAttempts = 0
    $deadlineInvoker = {
        param($Method, $Path, $Form, $TimeoutSeconds, $HeartbeatAction)
        $script:DeadlineAttempts++
        throw 'synthetic retry failure'
    }
    $deadlineWatch = [Diagnostics.Stopwatch]::StartNew()
    $deadlineError = ''
    try {
        $null = Invoke-AbbBackupRequest `
            -RequestInvoker $deadlineInvoker `
            -Method GET `
            -Path '/deadline' `
            -TimeoutSeconds 2 `
            -MaxAttempts 5 `
            -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(100))
    }
    catch {
        $deadlineError = $_.Exception.Message
    }
    $deadlineWatch.Stop()
    Assert-BackupTest ($deadlineError -match 'overall timeout') 'backup retries must honor the overall deadline'
    Assert-BackupTest ($script:DeadlineAttempts -eq 1) 'overall deadline must stop a second retry attempt'
    Assert-BackupTest ($deadlineWatch.ElapsedMilliseconds -lt 1000) 'overall deadline must fail promptly'

    $binaryPath = Join-Path $testRoot 'helper-binary.dat'
    $savedBinary = Save-AbbRwsFile `
        -Session $fakeSession `
        -Path '/binary' `
        -DestinationPath $binaryPath `
        -TimeoutSeconds 2 `
        -ExpectedBytes 4096
    Assert-BackupTest ($savedBinary.Bytes -eq 4096) 'binary download size should match'
    $binaryHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-BackupTest ($savedBinary.Sha256 -ceq $binaryHash) 'streaming SHA256 should match disk'
    $client.Dispose()
    $handler.Dispose()

    $backupName = 'offline_backup'
    $backupPath = Join-Path $testRoot $backupName
    $rootBytes = [byte[]](0..255)
    $moduleBytes = [Text.Encoding]::UTF8.GetBytes("MODULE MainModule`r`nENDMODULE`r`n")
    $mockState = @{
        Created = $false
        RootRequests = 0
        DirectoryRequests = 0
        PostRequests = 0
    }

    $newResponse = {
        param(
            [int]$StatusCode,
            [object]$Body,
            [string]$Location = ''
        )
        [pscustomobject]@{
            StatusCode = $StatusCode
            IsSuccess = ($StatusCode -ge 200 -and $StatusCode -le 299)
            Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 10 -Compress }
            FlatBody = ''
            Headers = @{}
            Location = $Location
        }
    }.GetNewClosure()

    $requestInvoker = {
        param(
            [string]$Method,
            [string]$Path,
            [hashtable]$Form,
            [int]$TimeoutSeconds,
            [scriptblock]$HeartbeatAction
        )
        if ($Method -eq 'POST' -and $Path -eq '/ctrl/backup?action=backup') {
            $mockState.PostRequests++
            Assert-BackupTest (
                $Form.backup -eq '/fileservice/$SYSPAR/offline_backup'
            ) 'backup form path should target SYSPAR'
            Assert-BackupTest ($Form.archive -eq 'FALSE') 'backup should request a directory'
            $mockState.Created = $true
            return & $newResponse 202 '' '/progress/1'
        }
        if ($Method -ne 'GET') {
            return & $newResponse 405 @{ error = 'method' }
        }
        if ($Path -eq '/progress/1?json=1') {
            return & $newResponse 200 @{
                _embedded = @{ _state = @(@{ state = 'DONE'; code = '294913' }) }
            }
        }
        if ($Path -eq '/fileservice/$SYSPAR/offline_backup/?json=1') {
            if (-not $mockState.Created) {
                return & $newResponse 404 @{ error = 'not-found' }
            }
            $mockState.DirectoryRequests++
            return & $newResponse 200 @{
                _embedded = @{
                    _state = @(@{
                        _type = 'fs-file'
                        _title = 'root.bin'
                        'fs-size' = $rootBytes.Length
                    })
                }
                _links = @{ next = @{ href = '/offline-page-2?cursor=2' } }
            }
        }
        if ($Path -eq '/offline-page-2?cursor=2&json=1') {
            return & $newResponse 200 @{
                _embedded = @{
                    _state = @(@{ _type = 'fs-dir-li'; _title = 'RAPID' })
                }
            }
        }
        if ($Path -eq '/fileservice/$SYSPAR/offline_backup/RAPID/?json=1') {
            return & $newResponse 200 @{
                _embedded = @{
                    _state = @(@{
                        _type = 'fs-file-li'
                        _title = 'MainModule.mod'
                        'fs-size' = $moduleBytes.Length
                    })
                }
            }
        }
        return & $newResponse 404 @{ error = 'not-found'; path = $Path }
    }.GetNewClosure()

    $fileDownloader = {
        param(
            [string]$Path,
            [string]$DestinationPath,
            [long]$ExpectedBytes,
            [int]$TimeoutSeconds,
            [scriptblock]$TransferProgressAction,
            [int]$HeartbeatMilliseconds
        )
        $bytes = if ($Path.EndsWith('/root.bin')) {
            $rootBytes
        } elseif ($Path.EndsWith('/RAPID/MainModule.mod')) {
            $moduleBytes
        } else {
            throw "Unexpected mock download path: $Path"
        }
        Assert-BackupTest ($ExpectedBytes -eq $bytes.Length) 'expected bytes should reach downloader'
        $parent = Split-Path -Parent $DestinationPath
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            $null = New-Item -ItemType Directory -Path $parent -Force
        }
        [IO.File]::WriteAllBytes($DestinationPath, $bytes)
        [pscustomobject]@{
            Path = $DestinationPath
            Bytes = [long]$bytes.Length
            ContentLength = [long]$bytes.Length
            Sha256 = [Convert]::ToHexString(
                [Security.Cryptography.SHA256]::HashData($bytes)
            ).ToLowerInvariant()
        }
    }.GetNewClosure()

    $identity = [pscustomobject]@{
        Name = 'OFFLINE'
        SystemId = '00000000-0000-0000-0000-000000000000'
        RobotWare = '6.10.1039'
    }
    $state = [pscustomobject]@{
        Opmode = 'MANR'
        ControllerState = 'motoroff'
        RapidState = 'stopped'
    }
    $statusEvents = [System.Collections.Generic.List[object]]::new()
    $statusAction = {
        param($Event)
        $statusEvents.Add($Event)
    }.GetNewClosure()

    $result = Invoke-AbbControllerBackup `
        -RequestInvoker $requestInvoker `
        -FileDownloader $fileDownloader `
        -BackupName $backupName `
        -LocalBackupPath $backupPath `
        -ControllerIdentity $identity `
        -StateBefore $state `
        -Alias 'offline' `
        -Cell '2500T' `
        -Robot 'R2' `
        -Endpoint 'http://offline.invalid' `
        -TimeoutSeconds 30 `
        -RequestTimeoutSeconds 2 `
        -PollIntervalMilliseconds 100 `
        -HeartbeatSeconds 1 `
        -StatusAction $statusAction
    Assert-BackupTest $result.Completed 'high-level backup should complete'
    Assert-BackupTest ($result.FileCount -eq 2) 'high-level backup should download two files'
    Assert-BackupTest ($result.RemoteBefore.Files.Count -eq 2) 'RemoteBefore should retain files'
    Assert-BackupTest ($result.RemoteAfter.Files.Count -eq 2) 'RemoteAfter should retain files'
    Assert-BackupTest (Test-Path -LiteralPath $result.ManifestPath) 'manifest should exist'
    Assert-BackupTest ($mockState.PostRequests -eq 1) 'backup POST must execute exactly once'
    Assert-BackupTest ($mockState.RootRequests -eq 0) 'backup must not enumerate the entire SYSPAR root'

    $manifestCheck = Test-AbbBackupManifest -Manifest $result.ManifestPath
    Assert-BackupTest $manifestCheck.Valid 'exact local manifest verification should pass'
    Assert-BackupTest $manifestCheck.LocalVerified 'LocalVerified should be true on exact match'
    Assert-BackupTest ($manifestCheck.LocalFileCount -eq 2) 'local verifier should count two files'

    $snapshot = Get-AbbRemoteBackupSnapshot `
        -RequestInvoker $requestInvoker `
        -BackupName $backupName `
        -TimeoutSeconds 2
    Assert-BackupTest $snapshot.Exists 'remote snapshot should exist after backup'
    Assert-BackupTest ($snapshot.FileCount -eq 2) 'remote snapshot should include pagination and recursion'

    $unexpected = Join-Path $backupPath 'unexpected.partial'
    [IO.File]::WriteAllBytes($unexpected, [byte[]](1, 2, 3))
    $invalidCheck = Test-AbbBackupManifest -Manifest $result.ManifestPath
    Assert-BackupTest (-not $invalidCheck.Valid) 'unexpected local file must invalidate manifest'
    Assert-BackupTest (-not $invalidCheck.LocalVerified) 'LocalVerified must reflect local mismatch'
    Assert-BackupTest (
        @($invalidCheck.LocalErrors | Where-Object { $_ -match 'Unexpected local backup file' }).Count -eq 1
    ) 'local mismatch should be reported'

    [pscustomobject]@{
        Passed = $true
        HelperHeartbeatCount = $script:BackupHeartbeatCount
        HelperRetryAttempts = $retried.Attempts
        OverallDeadlineMs = $deadlineWatch.ElapsedMilliseconds
        BinaryBytes = $savedBinary.Bytes
        BackupFiles = $result.FileCount
        BackupBytes = $result.TotalBytes
        RemoteTreeSha256 = $snapshot.TreeSha256
        StatusEvents = $statusEvents.Count
        ManifestExactMatch = $manifestCheck.Valid
        ExtraFileRejected = (-not $invalidCheck.Valid)
    } | ConvertTo-Json -Depth 5
}
finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith(
        $tempBase + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    ) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
        [IO.Directory]::Delete($resolvedTestRoot, $true)
    }
}
