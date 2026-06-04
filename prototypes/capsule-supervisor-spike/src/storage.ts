/* eslint-disable class-methods-use-this, require-await */

import { CapsuleRecordSchema } from "./schema.ts";
import type { CapsuleRecord } from "./schema.ts";

export class MemoryCapsuleStorage {
  private readonly values = new Map<string, unknown>();

  async getCapsule(workItemId: string): Promise<CapsuleRecord | undefined> {
    const value = this.values.get(this.key(workItemId));
    return value ? CapsuleRecordSchema.parse(value) : undefined;
  }

  async putCapsule(record: CapsuleRecord): Promise<void> {
    this.values.set(
      this.key(record.workItemId),
      CapsuleRecordSchema.parse(record)
    );
  }

  async snapshot(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.values.entries());
  }

  private key(workItemId: string): string {
    return `capsule:${workItemId}`;
  }
}
