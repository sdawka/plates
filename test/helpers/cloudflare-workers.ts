// Stand-in for the `cloudflare:workers` module (aliased in vitest.config.ts).
// DurableObject gets a ctx whose storage behaves like the real KV-style storage API plus alarms.

export class MemoryDurableObjectStorage {
  private data = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T = unknown>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>();
      for (const k of key) if (this.data.has(k)) out.set(k, structuredClone(this.data.get(k)) as T);
      return out;
    }
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.data.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) return key.filter((k) => this.data.delete(k)).length;
    return this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }

  async list<T = unknown>(opts: { prefix?: string } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.data].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!opts.prefix || k.startsWith(opts.prefix)) out.set(k, structuredClone(v) as T);
    }
    return out;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

export class MemoryDurableObjectState {
  readonly storage = new MemoryDurableObjectStorage();
  constructor(readonly id: { name: string }) {}
  waitUntil(_p: Promise<unknown>): void {}
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export class DurableObject<E = unknown> {
  constructor(readonly ctx: MemoryDurableObjectState, readonly env: E) {}
}
