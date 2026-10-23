export async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure;
  const workers = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }));
  // The caller owns the read lock until every issued operation has settled.
  if (failed) throw failure;
  return results;
}
