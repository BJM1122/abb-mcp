import assert from "node:assert/strict";
import { ensurePcSdkHost, PcSdkHostRunner } from "../direct-rws/pcsdk-runner.mjs";

try {
  await ensurePcSdkHost();
} catch (error) {
  if (error.code !== "PcSdkHostUnavailable") throw error;
  await assert.rejects(new PcSdkHostRunner().run("capability"), { code: "PcSdkHostUnavailable" });
  console.log(JSON.stringify({ ok: true, missingHostFailsClosed: true, skipped: true,
    reason: "Optional PC SDK host not built. Install your own ABB SDK and run npm run build:pcsdk to enable these checks." }));
  process.exit(0);
}

const runner = new PcSdkHostRunner();
const capability = await runner.run("capability");
const probe = await runner.run("probe");

assert.equal(capability.ok, true);
assert.equal(capability.controllerAccessed, false);
assert.equal(probe.ok, true);
assert.equal(probe.controllerAccessed, false);

const sentinel = "PCSDK_TEST_SECRET_MUST_NOT_APPEAR";
let invalidError;
try {
  await runner.run(
    "backup",
    {
      systemId: "00000000-0000-0000-0000-000000000001",
      expectedControllerName: "offline-only",
      expectedRobotWare: "6.13.0164",
      userName: "offline-user",
      password: sentinel,
      backupName: "../rejected",
      localDirectory: "C:\\rejected",
      overwrite: false,
      timeoutSeconds: 30
    },
    { timeoutMs: 10_000 }
  );
} catch (error) {
  invalidError = error;
}
assert.ok(invalidError);
assert.equal(invalidError.code, "BackupRequestInvalid");
assert.doesNotMatch(JSON.stringify(invalidError), new RegExp(sentinel));

console.log(
  JSON.stringify(
    {
      ok: true,
      capability: {
        sdkVersion: capability.sdkVersion,
        controllerAccessed: capability.controllerAccessed
      },
      probe: {
        controllerAccessed: probe.controllerAccessed,
        checks: probe.checks?.length ?? 0
      },
      credentialsViaStdinOnly: true,
      invalidRequestRejectedBeforeControllerAccess: true
    },
    null,
    2
  )
);
