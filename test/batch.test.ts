import { expect, test } from "bun:test";
import { runBatch } from "../src/batch.ts";

test("runs every batch item and reports successes and failures", async () => {
  const visited: number[] = [];
  const result = await runBatch([1, 2, 3], async (item) => {
    visited.push(item);
    if (item === 2) throw new Error("failed");
    return item * 10;
  });

  expect(visited).toEqual([1, 2, 3]);
  expect(result.succeeded).toEqual([
    { item: 1, result: 10 },
    { item: 3, result: 30 },
  ]);
  expect(result.failed.length).toBe(1);
  expect(result.failed[0]?.item).toBe(2);
  expect(String(result.failed[0]?.error)).toMatch(/failed/);
});
