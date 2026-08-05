import { StepInputValidationError } from '@sapiom/agent';

import { validateManifestStepInput } from './manifest-validation.js';

describe('validateManifestStepInput', () => {
  const schema = {
    type: 'object',
    properties: {
      callbackUrl: { type: 'string', format: 'uri' },
    },
    required: ['callbackUrl'],
  };

  it('accepts a valid URI format', () => {
    expect(() =>
      validateManifestStepInput('entry', schema, {
        callbackUrl: 'https://example.com/callback',
      }),
    ).not.toThrow();
  });

  it('rejects an invalid URI format', () => {
    expect(() =>
      validateManifestStepInput('entry', schema, {
        callbackUrl: 'not a uri',
      }),
    ).toThrow(StepInputValidationError);
  });
});
