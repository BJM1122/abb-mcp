const BACKUP_METHODS = new Set([
  "plan_backup",
  "apply_backup",
  "verify_backup"
]);
const CHANGESET_METHODS = new Set([
  "prepare_changeset",
  "commit_job",
  "verify_changeset"
]);
const DIRECT_SHARED_READ_METHODS = new Set([
  "snapshot",
  "read_signals",
  "list_modules",
  "list_config_instances",
  "read_config_instance",
  "read_module",
  "read_rapid_data",
  "read_current_robtarget"
]);
const DIRECT_EXCLUSIVE_METHODS = new Set([
  "register_controller",
  "bind",
  ...BACKUP_METHODS,
  "disconnect",
  "disconnect_idle"
]);
const DIRECT_NO_ALIAS_METHODS = new Set([
  "health",
  "list_controllers",
  "probe_controller"
]);
const DIRECT_METHODS = new Set([
  ...DIRECT_SHARED_READ_METHODS,
  ...DIRECT_EXCLUSIVE_METHODS,
  ...DIRECT_NO_ALIAS_METHODS
]);
const DIRECT_CHANGESET_PROTOCOL = "rws1+rws2";
const SMALL_SIGNAL_EXACT_THRESHOLD = 8;
const SNAPSHOT_MAX_PARALLEL_READS = 5;

function isDirectBackupMethod(method) {
  return BACKUP_METHODS.has(String(method || ""));
}

function isDirectChangesetMethod(method) {
  return CHANGESET_METHODS.has(String(method || ""));
}

function isDirectRwsMethod(method) {
  return DIRECT_METHODS.has(String(method || ""));
}

function directMethodLockMode(method) {
  return DIRECT_SHARED_READ_METHODS.has(String(method || ""))
    ? "read"
    : "write";
}

function directMethodRequestWeight(method, params, maxSockets, protocol = "rws1") {
  const capacity = Math.max(1, Math.floor(Number(maxSockets) || 1));
  if (directMethodLockMode(method) === "write") return capacity;
  if (String(method || "") === "snapshot") {
    return Math.min(capacity, SNAPSHOT_MAX_PARALLEL_READS);
  }
  if (String(method || "") !== "read_signals") return 1;
  const count = Array.isArray(params?.names) ? new Set(params.names).size : 0;
  return count > 0 && (protocol === "rws2" || count <= SMALL_SIGNAL_EXACT_THRESHOLD)
    ? Math.min(capacity, count)
    : 1;
}

export {
  BACKUP_METHODS,
  CHANGESET_METHODS,
  DIRECT_EXCLUSIVE_METHODS,
  DIRECT_METHODS,
  DIRECT_NO_ALIAS_METHODS,
  DIRECT_SHARED_READ_METHODS,
  DIRECT_CHANGESET_PROTOCOL,
  SMALL_SIGNAL_EXACT_THRESHOLD,
  SNAPSHOT_MAX_PARALLEL_READS,
  directMethodLockMode,
  directMethodRequestWeight,
  isDirectBackupMethod,
  isDirectChangesetMethod,
  isDirectRwsMethod
};
