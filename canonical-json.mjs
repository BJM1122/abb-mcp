function canonicalizeJsonValue(value, ancestors) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.toJSON === "function") {
    return canonicalizeJsonValue(value.toJSON(), ancestors);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Cannot canonicalize a cyclic JSON value.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeJsonValue(item, ancestors));
    }
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeJsonValue(value[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalizeJsonValue(value, new Set()));
}

function singleFlightKey(method, args) {
  return `${String(method)}\0${canonicalJsonStringify(args)}`;
}

export { canonicalJsonStringify, singleFlightKey };
