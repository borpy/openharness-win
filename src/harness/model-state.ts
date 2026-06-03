export type ReplModelState = {
  currentModel: string;
  sessionModel: string;
  manualModelOverride: boolean;
  systemPrompt: string;
};

export type ApplyReplModelChangeOptions = {
  manualOverride?: boolean;
  systemPromptBuilder?: (model: string) => string;
};

export function applyReplModelChange(
  state: ReplModelState,
  newModel: string,
  options: ApplyReplModelChangeOptions = {},
): ReplModelState {
  if (!newModel) return state;

  return {
    currentModel: newModel,
    sessionModel: newModel,
    manualModelOverride: options.manualOverride ? true : state.manualModelOverride,
    systemPrompt: options.systemPromptBuilder ? options.systemPromptBuilder(newModel) : state.systemPrompt,
  };
}
