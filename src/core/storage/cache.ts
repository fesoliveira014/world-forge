/** Byte budgets bound retained data rather than an arbitrary number of entries. */
export class ByteCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private retainedBytes = 0;

  constructor(readonly budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new Error('Cache budget must be a nonnegative byte count.');
    }
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.value;
  }

  set(key: string, value: T, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.retainedBytes -= previous.bytes;
    }
    if (bytes > this.budget) {
      return;
    }
    while (this.retainedBytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.retainedBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes });
    this.retainedBytes += bytes;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}
