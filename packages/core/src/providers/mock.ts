import { chatMessages } from './prompt';
import type { LlmProvider, StructuredRequest, StructuredResult } from './types';

/** Deterministic, offline provider. Output is labelled as mock everywhere it is stored. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-deterministic-v1';
  readonly supportsVision = true;
  readonly pricing = null;
  readonly family = null;
  async generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // same conversation rules as the real providers (ends with her message, known roles), nothing is sent
    if (req.conversation?.length) chatMessages(req);
    const output = req.schema.parse(req.mock());
    return { output, provider: 'mock', model: this.model, usage: null, costEstimateUsd: 0 };
  }
}
