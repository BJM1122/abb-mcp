import { DirectChangesetExecutor } from "./changeset-executor.mjs";
import { DirectChangesetManager } from "./changeset-manager.mjs";
import { DirectChangesetPlanner } from "./changeset-planner.mjs";
import { createDirectChangesetServiceApis } from "./changeset-service-adapter.mjs";
import {
  changesetPolicySignature,
  changesetPolicySnapshot
} from "./changeset-policy.mjs";
import { DIRECT_CHANGESET_PROTOCOL } from "./method-routing.mjs";

/**
 * Assemble the direct RWS1 changeset stack around one DirectRwsService.
 *
 * Registry policy is deliberately snapshotted when the stack is created. The
 * router selects the immutable policy generation for each changeset call.
 * Per-controller registry edits are still guarded by the adapter's current
 * Endpoint/ControllerLock readback.
 */
export function createDirectChangesetStack({
  service,
  policy = null,
  protocol = DIRECT_CHANGESET_PROTOCOL
} = {}) {
  if (!service || typeof service !== "object") {
    throw new Error("Direct changeset stack requires DirectRwsService.");
  }
  if (!service.registry || !service.registrySha256) {
    throw new Error(
      "Direct changeset stack requires a loaded controller registry."
    );
  }

  const registrySha256 = String(service.registrySha256);
  const policySnapshot = changesetPolicySnapshot(policy ?? service.registry);
  const policySha256 = changesetPolicySignature(policySnapshot);
  const { adapter, readApi, sessionApi } =
    createDirectChangesetServiceApis({
      service,
      policy: policySnapshot,
      protocol
    });
  const planner = new DirectChangesetPlanner({
    readApi,
    readConcurrency: service.maxSockets,
    allowedConfigDomains: policySnapshot.allowedConfigDomains,
    allowedLocalRoots: policySnapshot.allowedLocalRoots
  });
  const executor = new DirectChangesetExecutor({
    planner,
    readApi,
    sessionApi
  });
  const manager = new DirectChangesetManager({ planner, executor });
  let closed = false;

  return {
    protocol,
    registrySha256,
    policy: policySnapshot,
    policySha256,
    adapter,
    planner,
    executor,
    manager,
    async close() {
      if (closed) return;
      closed = true;
      let firstError = null;
      try {
        await manager.close();
      } catch (error) {
        firstError = error;
      }
      try {
        await adapter.close();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError) throw firstError;
    }
  };
}

export {
  changesetPolicySignature,
  changesetPolicySnapshot,
  DIRECT_CHANGESET_PROTOCOL
};
