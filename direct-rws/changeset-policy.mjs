import crypto from "node:crypto";

function policyArray(registry, name) {
  const value = registry?.[name];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Direct ABB changesets require registry.${name} to be a non-empty array.`
    );
  }
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(
      `Direct ABB changesets require registry.${name} to contain only ` +
        "non-empty strings."
    );
  }
  return [...value];
}

function normalizedPolicyValues(values, { lowerCase = false } = {}) {
  return [
    ...new Set(
      values
        .map((value) => String(value).trim())
        .filter(Boolean)
        .map((value) => lowerCase ? value.toLowerCase() : value)
    )
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function changesetPolicySnapshot(registryOrPolicy) {
  const allowedConfigDomains = policyArray(
    registryOrPolicy,
    "allowedConfigDomains"
  );
  const allowedLocalRoots = policyArray(
    registryOrPolicy,
    "allowedLocalRoots"
  );
  return Object.freeze({
    allowedConfigDomains: Object.freeze(
      normalizedPolicyValues(allowedConfigDomains, { lowerCase: true })
    ),
    allowedLocalRoots: Object.freeze(
      normalizedPolicyValues(allowedLocalRoots)
    )
  });
}

function changesetPolicySignature(registryOrPolicy) {
  const policy = changesetPolicySnapshot(registryOrPolicy);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(policy), "utf8")
    .digest("hex");
}

export { changesetPolicySignature, changesetPolicySnapshot };
