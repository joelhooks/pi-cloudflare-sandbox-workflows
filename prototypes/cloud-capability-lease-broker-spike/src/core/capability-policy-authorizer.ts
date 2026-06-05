import type {
  CapabilityLeaseRequest,
  CapabilityPolicyDecision,
} from "./schemas.ts";

export interface CapabilityPolicyAuthorizer {
  authorize(input: CapabilityLeaseRequest): Promise<CapabilityPolicyDecision>;
}
