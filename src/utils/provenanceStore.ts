/**
 * In-memory provenance store for grounding tokens.
 *
 * A grounding token proves that the model queried the real D365FO codebase
 * (via prepare_change) before generating extension code. Tokens expire after
 * TTL_MS to prevent stale context being reused across sessions.
 *
 * Enforcement: when GROUNDING_ENFORCE=true, extension patterns in generate_code
 * and extension objectTypes in create_d365fo_file will reject calls without a
 * valid token.
 */

import crypto from 'crypto';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ProvenanceContext {
  goal: string;
  objectName: string;
  methodName?: string;
  objectType?: string;
  /** Condensed facts gathered by prepare_change */
  methodSignature?: string;
  cocExtensions?: string;
  extensionEligibility?: string;
  recommendedStrategy?: string;
  namingValidation?: string;
  patterns?: string;
}

export interface ProvenanceBundle {
  token: string;
  context: ProvenanceContext;
  timestamp: number;
  expiresAt: number;
}

// Module-level singleton — shared across all requests in the process lifetime.
const store = new Map<string, ProvenanceBundle>();

function prune(): void {
  const now = Date.now();
  for (const [key, bundle] of store.entries()) {
    if (bundle.expiresAt < now) store.delete(key);
  }
}

export function createProvenanceToken(context: ProvenanceContext): string {
  prune();
  const payload = `${context.goal}:${context.objectName}:${context.methodName ?? ''}:${Date.now()}`;
  const token = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  const now = Date.now();
  store.set(token, {
    token,
    context,
    timestamp: now,
    expiresAt: now + TTL_MS,
  });
  return token;
}

export function getProvenanceBundle(token: string): ProvenanceBundle | undefined {
  prune();
  const bundle = store.get(token);
  if (!bundle) return undefined;
  if (bundle.expiresAt < Date.now()) {
    store.delete(token);
    return undefined;
  }
  return bundle;
}

export function isValidToken(token: string): boolean {
  return getProvenanceBundle(token) !== undefined;
}

/**
 * Enforce grounding for extension write operations.
 *
 * Returns an error result if:
 *   - GROUNDING_ENFORCE=true is set in the environment, AND
 *   - no valid grounding token was provided.
 *
 * Returns null when enforcement passes (either disabled or token is valid).
 */
export function enforceGrounding(
  groundingToken: string | undefined,
  operationDescription: string,
): { isError: true; content: [{ type: 'text'; text: string }] } | null {
  if (process.env.GROUNDING_ENFORCE !== 'true') return null;
  if (groundingToken && isValidToken(groundingToken)) return null;
  const reason = groundingToken
    ? 'the provided groundingToken has expired or is invalid'
    : 'no groundingToken was provided';
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `❌ Grounding required for ${operationDescription} (GROUNDING_ENFORCE=true).\n\n` +
        `Reason: ${reason}.\n\n` +
        `**Required workflow:**\n` +
        `1. Call \`prepare_change(goal="...", objectName="...")\` to gather facts from the D365FO index.\n` +
        `2. Pass the returned \`groundingToken\` as a parameter to this tool.\n\n` +
        `This ensures generated extension code is grounded in your actual codebase, not AI training data.\n\n` +
        `To disable enforcement (direct API / human use): set \`GROUNDING_ENFORCE=false\` in the server .env.`,
    }],
  };
}
