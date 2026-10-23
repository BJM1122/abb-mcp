import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DpapiCredentialProvider } from "../direct-rws/credential-provider.mjs";
import { PcSdkHostRunner } from "../direct-rws/pcsdk-runner.mjs";

if (process.env.ABB_MCP_PCSDK_LIVE_TEST !== "1") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "live test disabled" }));
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = process.env.ABB_MCP_REGISTRY ||
  path.join(here, "..", "controller-registry.json");
const alias = process.env.ABB_MCP_CONTROLLER_ALIAS || "robot2";
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const config = registry.controllers?.[alias];
if (!config) throw new Error(`Unknown controller alias: ${alias}`);

const provider = new DpapiCredentialProvider();
let credential = await provider.get(config);
try {
  const result = await new PcSdkHostRunner().run(
    "connect-probe",
    {
      systemId: config.expectedSystemId,
      expectedControllerName: config.expectedName,
      expectedRobotWare: config.expectedRobotWare,
      userName: config.username || credential.username,
      password: credential.password
    },
    { timeoutMs: 45_000 }
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        alias,
        controllerAccessed: result.controllerAccessed,
        controllerModified: result.controllerModified,
        backupCalled: result.backupCalled,
        getDirectoryCalled: result.getDirectoryCalled,
        controllerOptionStatus: result.controllerOptionStatus,
        requiredControllerOption: result.requiredControllerOption,
        result: result.result,
        hostElapsedMs: result.hostElapsedMs
      },
      null,
      2
    )
  );
} finally {
  credential = null;
  provider.clear();
}
