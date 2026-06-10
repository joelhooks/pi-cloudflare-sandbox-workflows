import type { CapabilityLeaseReceipt } from "./schemas.ts";

export interface CapabilityReceiptSink {
  record(receipt: CapabilityLeaseReceipt): Promise<void>;
}
