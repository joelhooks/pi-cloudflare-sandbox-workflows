import type {
  CapabilityLeaseRequest,
  CapabilityLeaseResult,
} from "./schemas.ts";

export interface CapabilityLeaseBroker {
  requestCapability(
    input: CapabilityLeaseRequest
  ): Promise<CapabilityLeaseResult>;
}
