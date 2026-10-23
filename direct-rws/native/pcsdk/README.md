# ABB PC SDK native backup host

This directory contains the first native C# execution path for ABB controller
backup. It does not invoke PowerShell.

## Current command surface

```powershell
node .\build.mjs
.\bin\abb-pcsdk-host.exe capability --sdk-dir C:\ABB_PCSDK\Bin
.\bin\abb-pcsdk-host.exe probe --sdk-dir C:\ABB_PCSDK\Bin
```

Both commands are strictly local. They load and inspect the installed PC SDK
assemblies but do not discover, instantiate, connect to, log on to, or modify a
controller.

`connect-probe` uses the same `systemId`, expected identity, user name, and
password fields as `backup`, also through stdin JSON. It only:

1. connects by exact SystemId;
2. verifies SystemId, controller name, and RobotWare;
3. logs on;
4. reports identity and connect/logon timings;
5. logs off and disposes the connection.

It does not call `Backup` or `GetDirectory`. A successful probe proves that the
controller-side PC SDK option is operational and reports either `616-1 PC
Interface` or `3119-1 RobotStudio Connect`. The known IRC5
`C0040419 ... required option 616-1` failure is classified explicitly.
Unrecognized errors retain exception type, HRESULT, RobHResult, RawMessage, and
inner-exception details so a generic network failure is not mislabeled as a
missing controller option.

The compiled `PcSdkBackupEngine.BackupAndDownload` method contains the
RobotStudio-like path:

1. connect by the exact SystemId;
2. verify SystemId, controller name, and RobotWare;
3. log on;
4. call `Controller.Backup("(BACKUP)$...")`;
5. wait for a successful `BackupCompleted` event;
6. call `Controller.FileSystem.GetDirectory(remote, local, overwrite)`;
7. log off and dispose the connection.

Untrusted OmniCore certificates are always rejected. There is no automatic
certificate acceptance path.

The `backup` command accepts its complete request only as JSON on standard
input. User names and passwords are never accepted as command-line arguments
and are not returned in result or error objects. Example shape:

```json
{
  "systemId": "00000000-0000-0000-0000-000000000000",
  "expectedControllerName": "controller-name",
  "expectedRobotWare": "6.13.0164",
  "userName": "controller-user",
  "password": "<provided by the secure credential provider>",
  "backupName": "backup_20260729_120000",
  "localDirectory": "C:\\absolute\\project\\backup_20260729_120000",
  "overwrite": false,
  "timeoutSeconds": 120
}
```

Do not store a real request in a script or JSON file. The MCP process should
write it directly to the prebuilt executable's stdin and then discard the
credential object.

The backup command is an internal transport. The existing MCP identity lock,
exact backup plan, single-use approval token, and fresh verification must run
before it is called. The helper does not mint or validate MCP approval tokens.

PC SDK 2025.2 normalizes the live IRC5 RobotWare string `6.13.0164` to the
`System.Version` value `6.13.0.0`. The helper therefore requires an exact
SystemId and controller name and matches the RobotWare major/minor pair when
PC SDK has discarded both suffix components. The direct RWS preflight remains
responsible for the complete RobotWare text lock before any backup call.

## Local dependencies

The build references these three exact-version assemblies from `C:\ABB_PCSDK\Bin`:

- `ABB.Robotics.Controllers.PC.dll`
- `RobotStudio.Services.RobApi.dll`
- `RobotStudio.Services.RobApi.Desktop.dll`

At runtime an allow-listed assembly resolver loads only these three ABB
assemblies from `--sdk-dir`. It rejects version mismatches.

The default build uses the installed .NET Framework 4.8 `csc.exe`. Set
`ABB_PCSDK_DIR` or `ABB_CSC_PATH` only when using a different verified local
installation.

## Unverified boundaries

- No real controller has been connected or backed up by this host.
- No live `connect-probe` has been run.
- The current controller's `616-1 PC Interface` option is not yet verified.
- IRC5/RW6 and OmniCore/RW7 require separate live compatibility tests.
- The backup command has not yet been connected to the MCP router.
- Local SHA-256 manifest generation and fresh-session verification remain in
  the existing higher-level workflow and are not yet part of this executable.
- PC SDK connection cancellation and timeout behavior still need a live fault
  test before this engine is enabled.
