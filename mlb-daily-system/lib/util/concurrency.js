// Bounded-concurrency worker pool. Runs `worker` over every item with at
// most `limit` in flight at once, a middle ground between a fully
// sequential for-loop (safe but slow once a roster pull means hundreds of
// players) and Promise.all over everything (fast but hammers a free,
// unauthenticated API with hundreds of simultaneous connections). One
// item's rejection doesn't stop the others; callers that need per-item
// error handling should catch inside `worker`.
export async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  async function runNext() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
}
