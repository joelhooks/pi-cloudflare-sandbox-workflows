import type { StatusProjectionStore } from "../core/ports";
import type { WorkflowEvent } from "../core/events";

export class DurableObjectStatusProjectionStore implements StatusProjectionStore {
  constructor(private readonly storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }) {}
  async update(event: WorkflowEvent): Promise<void> {
    const key = "status:" + event.runId;
    const current = (await this.storage.get<Record<string, unknown>>(key)) ?? {};
    await this.storage.put(key, { ...current, lastEvent: event.event, state: event.state, updatedAt: event.timestamp });
  }
  async read(runId: string): Promise<unknown> {
    return this.storage.get("status:" + runId);
  }
}
