import type { CapabilityReceiptSink } from "../core/capability-receipt-sink.ts";
import type { CapabilityLeaseReceipt } from "../core/schemas.ts";

export interface CapabilityReceiptStorage {
  appendReceipt(receipt: CapabilityLeaseReceipt): Promise<void>;
}

export class DurableObjectCapabilityReceiptSink implements CapabilityReceiptSink {
  private readonly storage: CapabilityReceiptStorage;

  constructor(storage: CapabilityReceiptStorage) {
    this.storage = storage;
  }

  record(receipt: CapabilityLeaseReceipt): Promise<void> {
    return this.storage.appendReceipt(receipt);
  }
}
