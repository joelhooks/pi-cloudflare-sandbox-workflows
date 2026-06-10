import { createActor, setup } from "xstate";

import type { DynamicWorkflowMachineDocument } from "../domain/schemas.ts";
import { DynamicWorkflowMachineDocumentSchema } from "../domain/schemas.ts";

export const createGeneratedWorkflowActor = (
  input: DynamicWorkflowMachineDocument
) => {
  const document = DynamicWorkflowMachineDocumentSchema.parse(input);
  const machineSetup = setup({
    types: {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- XState setup uses phantom values to bind generic event types.
      events: {} as { type: string },
    },
  });
  const machineConfig = {
    id: document.xstate.id,
    initial: document.xstate.initial,
    states: Object.fromEntries(
      Object.entries(document.xstate.states).map(([stateName, state]) => [
        stateName,
        state.type === undefined
          ? { meta: state.meta, on: state.on }
          : { meta: state.meta, on: state.on, type: state.type },
      ])
    ),
  } as Parameters<typeof machineSetup.createMachine>[0];
  const machine = machineSetup.createMachine(machineConfig);

  return createActor(machine);
};

export const dynamicWorkflowStateValue = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  return null;
};

export const renderGeneratedWorkflowMachineSource = (
  input: DynamicWorkflowMachineDocument
): string => {
  const document = DynamicWorkflowMachineDocumentSchema.parse(input);
  const config = JSON.stringify(document.xstate, null, 2);

  return [
    'import { setup } from "xstate";',
    "",
    `export const dynamicWorkflowMachineConfig = ${config} as const;`,
    "",
    "export const dynamicWorkflowMachine = setup({}).createMachine(",
    "  dynamicWorkflowMachineConfig",
    ");",
    "",
  ].join("\n");
};
