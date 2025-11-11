/**
 * LangChain Model Wrappers - Per-Provider Extension Pattern
 *
 * Each provider (OpenAI, Anthropic, etc.) gets its own Sapiom-tracked class
 * that extends the provider's chat model directly. This ensures:
 * - Zero delegation needed (all methods inherited)
 * - True instanceof checks work
 * - Provider-specific customization possible
 * - Explicit support list for clarity
 */

import { SapiomChatOpenAI } from './models/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { SapiomClient } from '../../lib/SapiomClient';

// Re-export provider models
export { SapiomChatOpenAI } from './models/openai';
export { SapiomChatAnthropic } from './models/anthropic';

/**
 * Note: With drop-in replacement pattern, users create SapiomChatOpenAI directly
 * instead of wrapping an existing instance.
 *
 * Before (wrapper pattern):
 *   const model = new ChatOpenAI({ ... });
 *   const tracked = createSapiomModel(model);
 *
 * Now (drop-in replacement):
 *   const model = new SapiomChatOpenAI({ ... }, { sapiomConfig });
 *
 * This is simpler and avoids constructor complexity.
 */
