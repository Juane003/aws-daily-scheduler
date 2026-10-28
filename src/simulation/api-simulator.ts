import type { Clock } from '../core/ports.js';
import type { ApiRequest, ApiResponse, InternalApi } from '../core/ports.js';
import type { VirtualTimers } from './virtual-timers.js';

/**
 * Simulated internal API — not a model of the real one's performance. Per provider: a latency
 * range and the probability of a 5xx or a 4xx. Latency elapses on the virtual clock, so calls
 * overlap in simulated time, and the simulator records how many calls each provider has in flight
 * at once: the integration tests assert that this never exceeds 1 (the FIFO group guarantee).
 */

export interface ProviderProfile {
  /** Uniform in `[min, max]` milliseconds. */
  latencyMs: readonly [number, number];
  error5xxRate: number;
  error4xxRate: number;
}

export const DEFAULT_PROFILE: ProviderProfile = {
  latencyMs: [200, 1000],
  error5xxRate: 0,
  error4xxRate: 0,
};

export interface CallRecord {
  providerId: string;
  idempotencyKey: string;
  startedAt: number;
  endedAt: number;
  /** HTTP status, or `TIMEOUT` when the client gave up. */
  outcome: number | 'TIMEOUT';
}

export class ApiSimulator implements InternalApi {
  readonly calls: CallRecord[] = [];
  private readonly active = new Map<string, number>();
  private readonly peak = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly timers: VirtualTimers,
    private readonly profileOf: (providerId: string) => ProviderProfile,
    private readonly random: () => number,
  ) {}

  async call(request: ApiRequest): Promise<ApiResponse> {
    const providerId = request.headers['X-Provider-Id'] ?? 'unknown';
    const profile = this.profileOf(providerId);
    const startedAt = this.clock.now().getTime();
    const active = (this.active.get(providerId) ?? 0) + 1;
    this.active.set(providerId, active);
    this.peak.set(providerId, Math.max(this.peak.get(providerId) ?? 0, active));

    const [min, max] = profile.latencyMs;
    const latency = Math.round(min + this.random() * (max - min));
    const record = (outcome: CallRecord['outcome']) => {
      this.active.set(providerId, (this.active.get(providerId) ?? 1) - 1);
      this.calls.push({
        providerId,
        idempotencyKey: request.headers['Idempotency-Key'] ?? '',
        startedAt,
        endedAt: this.clock.now().getTime(),
        outcome,
      });
    };

    if (latency > request.timeoutMs) {
      await this.timers.sleep(request.timeoutMs);
      record('TIMEOUT');
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    }
    await this.timers.sleep(latency);
    const roll = this.random();
    const status =
      roll < profile.error5xxRate
        ? 503
        : roll < profile.error5xxRate + profile.error4xxRate
          ? 422
          : 200;
    record(status);
    return {
      status,
      headers: {},
      body: status === 200 ? JSON.stringify({ provider: providerId, ok: true }) : '',
    };
  }

  /** Highest number of simultaneous calls seen per provider. */
  peakConcurrency(): Map<string, number> {
    return new Map(this.peak);
  }

  callsTo(providerId: string): CallRecord[] {
    return this.calls.filter((c) => c.providerId === providerId);
  }
}
