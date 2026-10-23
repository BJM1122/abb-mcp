import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(sourceDirectory, "bin");
const executable = path.join(outputDirectory, "abb-pcsdk-host.exe");
const sdkDirectory =
  process.env.ABB_PCSDK_DIR?.trim() || String.raw`C:\ABB_PCSDK\Bin`;
const windowsDirectory = process.env.WINDIR || String.raw`C:\Windows`;
const cscCandidates = [
  process.env.ABB_CSC_PATH,
  path.join(
    windowsDirectory,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe"
  ),
  path.join(
    windowsDirectory,
    "Microsoft.NET",
    "Framework",
    "v4.0.30319",
    "csc.exe"
  )
].filter(Boolean);

const requiredSdkAssemblies = [
  "ABB.Robotics.Controllers.PC.dll",
  "RobotStudio.Services.RobApi.dll",
  "RobotStudio.Services.RobApi.Desktop.dll"
].map((name) => path.join(sdkDirectory, name));

const sources = [
  "AssemblyInfo.cs",
  "Program.cs",
  "SdkAssemblyResolver.cs",
  "PcSdkCapability.cs",
  "PcSdkErrorClassifier.cs",
  "PcSdkBackupEngine.cs"
].map((name) => path.join(sourceDirectory, name));

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

const csc = await (async () => {
  for (const candidate of cscCandidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error("No .NET Framework C# compiler was found.");
})();

for (const sdkAssembly of requiredSdkAssemblies) {
  if (!(await exists(sdkAssembly))) {
    throw new Error(`Required ABB PC SDK assembly is missing: ${sdkAssembly}`);
  }
}

for (const source of sources) {
  if (!(await exists(source))) {
    throw new Error(`C# source is missing: ${source}`);
  }
}

await mkdir(outputDirectory, { recursive: true });

const compilerArguments = [
  "/nologo",
  "/target:exe",
  "/platform:anycpu",
  "/optimize+",
  `/out:${executable}`,
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Web.Extensions.dll",
  ...requiredSdkAssemblies.map((assembly) => `/reference:${assembly}`),
  ...sources
];

const compile = spawnSync(csc, compilerArguments, {
  cwd: sourceDirectory,
  encoding: "utf8",
  windowsHide: true
});

if (compile.error) {
  throw compile.error;
}

if (compile.status !== 0) {
  throw new Error(
    `PC SDK host compilation failed (${compile.status}).\n` +
      `${compile.stdout || ""}${compile.stderr || ""}`
  );
}

await copyFile(
  path.join(sourceDirectory, "App.config"),
  `${executable}.config`
);

function runProbe(command) {
  const result = spawnSync(
    executable,
    [command, "--sdk-dir", sdkDirectory],
    {
      cwd: outputDirectory,
      encoding: "utf8",
      windowsHide: true
    }
  );

  if (result.error) {
    throw result.error;
  }

  const output = (result.stdout || "").trim();
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${output}\n${result.stderr || ""}`
    );
  }

  const lines = output.split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

const capability = runProbe("capability");
const probe = runProbe("probe");
const invalidConnectProbe = spawnSync(
  executable,
  ["connect-probe", "--sdk-dir", sdkDirectory],
  {
    cwd: outputDirectory,
    encoding: "utf8",
    input: "{}",
    windowsHide: true
  }
);

if (invalidConnectProbe.error) {
  throw invalidConnectProbe.error;
}

const invalidConnectProbeOutput = (invalidConnectProbe.stdout || "").trim();
const invalidConnectProbeLines = invalidConnectProbeOutput
  .split(/\r?\n/)
  .filter(Boolean);
const invalidConnectProbeResult = JSON.parse(
  invalidConnectProbeLines.at(-1)
);
if (
  invalidConnectProbe.status !== 2 ||
  invalidConnectProbeResult.ok !== false ||
  invalidConnectProbeResult.controllerAccessed !== false
) {
  throw new Error(
    "The offline connect-probe guard did not reject an invalid request before controller access."
  );
}

const invalidBackup = spawnSync(
  executable,
  ["backup", "--sdk-dir", sdkDirectory],
  {
    cwd: outputDirectory,
    encoding: "utf8",
    input: "{}",
    windowsHide: true
  }
);

if (invalidBackup.error) {
  throw invalidBackup.error;
}

const invalidBackupOutput = (invalidBackup.stdout || "").trim();
const invalidBackupLines = invalidBackupOutput.split(/\r?\n/).filter(Boolean);
const invalidBackupResult = JSON.parse(invalidBackupLines.at(-1));
if (
  invalidBackup.status !== 2 ||
  invalidBackupResult.ok !== false ||
  invalidBackupResult.controllerAccessed !== false
) {
  throw new Error(
    "The offline backup-input guard did not reject an invalid request before controller access."
  );
}

const credentialSentinel = "OFFLINE_SENTINEL_PASSWORD_DO_NOT_ECHO";
const guardedBackupRequest = JSON.stringify({
  systemId: "00000000-0000-0000-0000-000000000001",
  expectedControllerName: "offline-probe",
  expectedRobotWare: "6.13.0164",
  userName: "offline-user",
  password: credentialSentinel,
  backupName: "offline_probe",
  localDirectory: sourceDirectory,
  overwrite: false,
  timeoutSeconds: 120
});
const credentialGuard = spawnSync(
  executable,
  ["backup", "--sdk-dir", sdkDirectory],
  {
    cwd: outputDirectory,
    encoding: "utf8",
    input: guardedBackupRequest,
    windowsHide: true
  }
);

if (credentialGuard.error) {
  throw credentialGuard.error;
}

const credentialGuardOutput = (credentialGuard.stdout || "").trim();
const credentialGuardLines = credentialGuardOutput
  .split(/\r?\n/)
  .filter(Boolean);
const credentialGuardResult = JSON.parse(credentialGuardLines.at(-1));
if (
  credentialGuard.status !== 2 ||
  credentialGuardResult.ok !== false ||
  credentialGuardResult.controllerAccessed !== false ||
  credentialGuardOutput.includes(credentialSentinel) ||
  (credentialGuard.stderr || "").includes(credentialSentinel)
) {
  throw new Error(
    "The stdin credential guard did not reject locally or echoed credential material."
  );
}

const connectCredentialSentinel =
  "OFFLINE_CONNECT_SENTINEL_PASSWORD_DO_NOT_ECHO";
const guardedConnectRequest = JSON.stringify({
  systemId: "00000000-0000-0000-0000-000000000001",
  expectedControllerName: "offline-probe",
  expectedRobotWare: "6.13.0164",
  userName: "",
  password: connectCredentialSentinel
});
const connectCredentialGuard = spawnSync(
  executable,
  ["connect-probe", "--sdk-dir", sdkDirectory],
  {
    cwd: outputDirectory,
    encoding: "utf8",
    input: guardedConnectRequest,
    windowsHide: true
  }
);

if (connectCredentialGuard.error) {
  throw connectCredentialGuard.error;
}

const connectCredentialOutput =
  (connectCredentialGuard.stdout || "").trim();
const connectCredentialLines = connectCredentialOutput
  .split(/\r?\n/)
  .filter(Boolean);
const connectCredentialResult = JSON.parse(
  connectCredentialLines.at(-1)
);
if (
  connectCredentialGuard.status !== 2 ||
  connectCredentialResult.ok !== false ||
  connectCredentialResult.controllerAccessed !== false ||
  connectCredentialOutput.includes(connectCredentialSentinel) ||
  (connectCredentialGuard.stderr || "").includes(
    connectCredentialSentinel
  )
) {
  throw new Error(
    "The connect-probe stdin credential guard failed or echoed credential material."
  );
}

const executableStat = await stat(executable);

console.log(
  JSON.stringify({
    ok: true,
    executable,
    bytes: executableStat.size,
    sdkDirectory,
    csc,
    capability,
    probe,
    connectProbeInputGuard: invalidConnectProbeResult,
    connectProbeCredentialGuard: connectCredentialResult,
    backupInputGuard: invalidBackupResult,
    backupCredentialGuard: credentialGuardResult
  })
);
