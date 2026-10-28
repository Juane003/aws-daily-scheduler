/**
 * Small data structures that keep the in-memory queues O(log n) per operation, so the scale
 * simulation can push millions of messages through them.
 */

/** Array-backed FIFO with amortized O(1) shift. */
export class Deque<T> {
  private items: T[] = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  peek(): T | undefined {
    return this.items[this.head];
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = this.head; i < this.items.length; i++) yield this.items[i] as T;
  }
}

/** Binary min-heap ordered by `less`. */
export class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i] as T, items[parent] as T)) break;
      [items[i], items[parent]] = [items[parent] as T, items[i] as T];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    items[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < items.length && this.less(items[left] as T, items[smallest] as T)) smallest = left;
      if (right < items.length && this.less(items[right] as T, items[smallest] as T)) {
        smallest = right;
      }
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest] as T, items[i] as T];
      i = smallest;
    }
    return top;
  }
}
