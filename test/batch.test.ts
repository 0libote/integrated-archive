import assert from "node:assert/strict";
import test from "node:test";
import { runBatch } from "../src/batch.ts";

test("runs every batch item and reports successes and failures", async () => {
  const visited: number[] = [];
  const result = await runBatch([1, 2, 3], async (item) => {
    visited.push(item);
    if (item === 2) throw new Error("failed");
    return item * 10;
  });

  assert.deepEqual(visited, [1, 2, 3]);
  assert.deepEqual(result.succeeded, [
    { item: 1, result: 10 },
    { item: 3, result: 30 },
  ]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.item, 2);
  assert.match(String(result.failed[0]?.error), /failed/);
});
