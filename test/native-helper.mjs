import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureCredentialHelper
} from "../direct-rws/credential-provider.mjs";

const built = await ensureCredentialHelper();
const builtStat = await stat(built);
assert.ok(builtStat.isFile());
assert.ok(builtStat.size > 0);

const temporary = await mkdtemp(path.join(os.tmpdir(), "abb-native-helper-test-"));
try {
  await copyFile(
    new URL("../direct-rws/credential-provider.mjs", import.meta.url),
    path.join(temporary, "credential-provider.mjs")
  );
  await copyFile(
    new URL("../direct-rws/credential-helper.cs", import.meta.url),
    path.join(temporary, "credential-helper.cs")
  );
  const isolated = await import(
    `${pathToFileURL(path.join(temporary, "credential-provider.mjs")).href}?test=${Date.now()}`
  );
  await assert.rejects(
    isolated.ensureCredentialHelper(),
    (error) => {
      assert.equal(error.code, "NativeHelperUnavailable");
      assert.match(error.message, /npm run build:native/i);
      return true;
    }
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      prebuiltHelper: built,
      bytes: builtStat.size,
      onlineCompileAttempted: false,
      missingHelperFailsClosed: true
    },
    null,
    2
  )
);
