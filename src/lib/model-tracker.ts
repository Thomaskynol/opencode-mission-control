/**
 * Tracks the current model selected in the control center session.
 * Used to spawn child agents with the same model as the parent.
 *
 * Model is captured from multiple sources (in priority order):
 * 1. Per-session Map[sessionID] — stores model per OpenCode session
 * 2. lastSetModel — the most recently set model (any session), used as fallback
 * 3. config fallback — reads the default model from opencode config at plugin init
 */

export interface ModelInfo {
  providerID: string;
  modelID: string;
  /** Pinned variant when the installation reports one (pin triplo). CLI `-m` has no variant form. */
  variant?: string;
}

/** Per-session model storage, keyed by sessionID. Capped at MAX_SESSION_ENTRIES. */
const sessionModels: Map<string, ModelInfo> = new Map();
const MAX_SESSION_ENTRIES = 20;

/** Module-level fallback: the last model set from any session. */
let lastSetModel: ModelInfo | undefined;

/** Config-based fallback model string (format: "provider/model"). */
let configFallbackModel: string | undefined;

/**
 * Evict the oldest entry from sessionModels if at capacity.
 * Uses Map iteration order (insertion order) for FIFO eviction.
 */
function evictIfNeeded(): void {
  if (sessionModels.size >= MAX_SESSION_ENTRIES) {
    const oldest = sessionModels.keys().next().value;
    if (oldest !== undefined) {
      sessionModels.delete(oldest);
    }
  }
}

/**
 * Update the tracked model from a chat.message hook or message.updated event.
 * If sessionID is provided, stores per-session. Always updates lastSetModel.
 */
export function setCurrentModel(model: ModelInfo | undefined, sessionID?: string): void {
  if (!model?.providerID || !model?.modelID) {
    return;
  }
  const info: ModelInfo = { providerID: model.providerID, modelID: model.modelID };
  if (model.variant !== undefined) info.variant = model.variant;

  lastSetModel = info;

  if (sessionID) {
    // Delete first to refresh insertion order on re-set
    sessionModels.delete(sessionID);
    evictIfNeeded();
    sessionModels.set(sessionID, info);
  }
}

/**
 * Set the fallback model string from opencode config (format: "provider/model").
 * Used when no model has been captured from events yet.
 */
export function setConfigFallbackModel(modelString: string | undefined): void {
  if (modelString && modelString.includes('/')) {
    configFallbackModel = modelString;
  }
}

/**
 * Get the current model as a CLI-compatible string (provider/model).
 *
 * Priority chain:
 * 1. sessionModels[sessionID] (if sessionID provided and present)
 * 2. lastSetModel (most recently set from any session)
 * 3. configFallbackModel (from opencode config)
 * 4. undefined
 */
export function getCurrentModel(sessionID?: string): string | undefined {
  let model: ModelInfo | undefined;

  if (sessionID && sessionModels.has(sessionID)) {
    model = sessionModels.get(sessionID);
  } else if (lastSetModel) {
    model = lastSetModel;
  }

  return model
    ? `${model.providerID}/${model.modelID}`
    : configFallbackModel;
}

/**
 * Get the raw model info object (incl. variant when pinned).
 * Priority: sessionModels[sessionID] → lastSetModel → config fallback → undefined
 */
export function getCurrentModelInfo(sessionID?: string): ModelInfo | undefined {
  if (sessionID && sessionModels.has(sessionID)) {
    const m = sessionModels.get(sessionID)!;
    return { ...m };
  }
  if (lastSetModel) return { ...lastSetModel };
  if (configFallbackModel) {
    const slash = configFallbackModel.indexOf('/');
    if (slash > 0) {
      return { providerID: configFallbackModel.slice(0, slash), modelID: configFallbackModel.slice(slash + 1) };
    }
  }
  return undefined;
}

/**
 * Effective model triple for one execution (installation real, variant when pinned).
 * Same chain as getCurrentModel but preserves variant for serve paths.
 */
export function getCurrentModelRef(sessionID?: string): { providerID: string; id: string; variant?: string } | undefined {
  const info = getCurrentModelInfo(sessionID);
  if (!info) return undefined;
  return info.variant !== undefined
    ? { providerID: info.providerID, id: info.modelID, variant: info.variant }
    : { providerID: info.providerID, id: info.modelID };
}

/**
 * Fail-closed accessor for the serve/worker path: returns the tracked
 * triple (variant preserved) or throws — never a silent installation
 * default. String fallbacks (getCurrentModel / config) drop the variant;
 * this ref keeps it so planner and worker share the effective model.
 */
export function requireTrackedModelRef(sessionID?: string): { providerID: string; id: string; variant?: string } {
  const ref = getCurrentModelRef(sessionID);
  if (!ref) {
    throw new Error(
      '[MC] serve mode requires a pinned model, none tracked for this session — ' +
      'set it via the model tracker (or coordinator snapshot) instead of running unpinned.',
    );
  }
  return ref;
}

/**
 * Clear the tracked model.
 * If sessionID is provided, clears only that session entry.
 * If no sessionID, clears lastSetModel.
 */
export function clearCurrentModel(sessionID?: string): void {
  if (sessionID) {
    sessionModels.delete(sessionID);
  } else {
    lastSetModel = undefined;
  }
}

/**
 * Set the current model from an SDK Model object (as received in chat.params hook).
 * Maps Model.id → ModelInfo.modelID and Model.providerID → ModelInfo.providerID.
 */
export function setCurrentModelFromSDK(
  model: { id: string; providerID: string; variant?: string } | undefined,
  sessionID?: string,
): void {
  if (!model?.id || !model?.providerID) {
    return;
  }
  setCurrentModel({ providerID: model.providerID, modelID: model.id, ...(model.variant !== undefined ? { variant: model.variant } : {}) }, sessionID);
}

/**
 * Reset all state. Exported for testing only.
 * @internal
 */
export function _resetForTesting(): void {
  sessionModels.clear();
  lastSetModel = undefined;
  configFallbackModel = undefined;
}

/**
 * Get the session models map size. Exported for testing only.
 * @internal
 */
export function _getSessionMapSize(): number {
  return sessionModels.size;
}
