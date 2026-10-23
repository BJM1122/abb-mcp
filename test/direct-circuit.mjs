import assert from "node:assert/strict";
import path from "node:path";

import { RwsHttpError } from "../direct-rws/digest-http-client.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const alias = "robot_a";
const service = new DirectRwsService({
  registryPath: path.join(process.cwd(), "controller-registry.json"),
  offlineCooldownMs: 5_000
});

try {
  service.registerTransportFailure(
    alias,
    new RwsHttpError("Read failed HTTP 500: operation timeout", {
      statusCode: 500,
      method: "GET",
      url: "http://192.0.2.10/rw/system"
    })
  );
  assert.equal(service.transportFailures.has(alias), false);
  assert.doesNotThrow(() => service.assertCircuit(alias));

  service.registerTransportFailure(
    alias,
    Object.assign(new Error("HTTP 403: request timed out"), { statusCode: 403 })
  );
  assert.equal(service.transportFailures.has(alias), false);

  service.registerTransportFailure(
    alias,
    Object.assign(new Error("upstream timeout response"), { code: "EHTTP" })
  );
  assert.equal(
    service.transportFailures.has(alias),
    false,
    "message fallback must not override an explicit non-transport error code"
  );

  service.registerTransportFailure(
    alias,
    Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" })
  );
  assert.equal(service.transportFailures.get(alias)?.kind, "transport");
  assert.throws(
    () => service.assertCircuit(alias),
    /ControllerUnavailableCached:.*lastFailureKind=transport/
  );

  service.transportFailures.clear();
  service.registerTransportFailure(alias, new Error("connection refused by target"));
  assert.equal(service.transportFailures.get(alias)?.kind, "transport");
  assert.equal(service.metricsFor(alias).TransportFailureCount, 2);

  console.log("direct circuit classification tests passed");
} finally {
  await service.close();
}
