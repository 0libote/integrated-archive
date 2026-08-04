export interface BatchSuccess<Item, Result> {
  item: Item;
  result: Result;
}

export interface BatchFailure<Item> {
  error: unknown;
  item: Item;
}

export interface BatchResult<Item, Result> {
  failed: Array<BatchFailure<Item>>;
  succeeded: Array<BatchSuccess<Item, Result>>;
}

export async function runBatch<Item, Result>(
  items: Item[],
  operation: (item: Item) => Promise<Result>,
): Promise<BatchResult<Item, Result>> {
  const result: BatchResult<Item, Result> = { failed: [], succeeded: [] };
  for (const item of items) {
    try {
      result.succeeded.push({ item, result: await operation(item) });
    } catch (error) {
      result.failed.push({ error, item });
    }
  }
  return result;
}
