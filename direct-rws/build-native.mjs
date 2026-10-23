import { stat } from "node:fs/promises";
import { ensureCredentialHelper } from "./credential-provider.mjs";

const executable = await ensureCredentialHelper({ allowBuild: true });
const item = await stat(executable);
console.log(
  JSON.stringify({
    ok: true,
    executable,
    bytes: item.size,
    modifiedAt: item.mtime.toISOString()
  })
);
