import { describe, it, expect } from 'vitest';
import { ComputeProvisionerTool } from './computeProvisioner.js';

describe('ComputeProvisionerTool', () => {
  const tool = new ComputeProvisionerTool();

  it('should provide a valid MCP tool definition schema', () => {
    const def = tool.getDefinition();
    expect(def.name).toBe('sapiom_provision_compute');
    expect(def.description).toContain('Provision on-demand cloud compute');
    expect(def.inputSchema).toBeDefined();
  });

  it('should successfully provision compute when within budget', () => {
    const res = tool.execute({
      instanceType: 'cpu-large', // 0.20/h
      maxDurationHours: 5,       // Total = 1.00
      maxBudgetUsd: 2.00,
      region: 'us-east-1',
    });

    expect(res.success).toBe(true);
    expect(res.instanceId).toBeDefined();
    expect(res.hourlyRateUsd).toBe(0.20);
    expect(res.totalEstimatedCostUsd).toBe(1.00);
  });

  it('should reject provisioning when estimated cost exceeds max budget', () => {
    const res = tool.execute({
      instanceType: 'gpu-h100', // 3.50/h
      maxDurationHours: 10,     // Total = 35.00
      maxBudgetUsd: 15.00,
      region: 'us-east-1',
    });

    expect(res.success).toBe(false);
    expect(res.message).toContain('Budget exceeded');
    expect(res.totalEstimatedCostUsd).toBe(35.00);
  });

  it('should handle MCP formatted tool calls successfully', () => {
    const mcpResponse = tool.handleMcpCall({
      instanceType: 'cpu-small',
      maxDurationHours: 2,
      maxBudgetUsd: 1.00,
      region: 'eu-west-1',
    });

    expect(mcpResponse.isError).toBe(false);
    expect(mcpResponse.content[0].type).toBe('text');
    const parsedData = JSON.parse(mcpResponse.content[0].text);
    expect(parsedData.success).toBe(true);
  });

  it('should return error response on invalid input parameters in MCP call', () => {
    const mcpResponse = tool.handleMcpCall({
      instanceType: 'invalid-gpu-type',
      maxDurationHours: -1,
      maxBudgetUsd: -5,
    });

    expect(mcpResponse.isError).toBe(true);
    expect(mcpResponse.content[0].text).toContain('Validation error');
  });
});

