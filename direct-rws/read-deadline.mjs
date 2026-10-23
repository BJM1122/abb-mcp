export function readDeadlineError() {
  const error = new Error("ABB read overall deadline expired.");
  error.code = "ReadDeadlineExceeded";
  return error;
}

export function remainingReadTime(deadlineAt) {
  if (deadlineAt === undefined) return undefined;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw readDeadlineError();
  return remaining;
}
