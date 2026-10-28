import type { ObjectStore } from '../../core/ports.js';

/** In-memory S3 bucket for oversized result payloads. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, string>();

  put(key: string, body: string): Promise<void> {
    this.objects.set(key, body);
    return Promise.resolve();
  }

  get(key: string): string | undefined {
    return this.objects.get(key);
  }

  get size(): number {
    return this.objects.size;
  }
}
