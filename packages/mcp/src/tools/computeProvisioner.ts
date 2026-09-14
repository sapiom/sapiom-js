/**
 * Sapiom MCP Compute Provisioning Tool Adapter.
 * Allows autonomous agents to provision cloud compute resources via Sapiom agentic rails.
 */

import { z } from 'zod';

export const ProvisionComputeInputSchema = z.object({
  instanceType: z.enum(['cpu-small', 'cpu-large', 'gpu-h100', 'gpu-a10g']),
  region: z.string().default('us-east-1'),
  maxDurationHours: z.number().min(1).max(72),
  maxBudgetUsd: z.number().positive(),
});

export type ProvisionComputeInput = z.infer<typeof ProvisionComputeInputSchema>;

export interface ProvisioningResult {
  success: boolean;
  instanceId?: string;
  hourlyRateUsd?: number;
  totalEstimatedCostUsd?: number;
  message: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ComputeProvisionerTool {
  public static readonly toolName = 'sapiom_provision_compute';
  public static readonly toolDescription = 
    'Provision on-demand cloud compute (CPU/GPU) with automatic budget caps and Sapiom micropayment rails.';

  private hourlyRates: Record<string, number> = {
    'cpu-small': 0.05,
    'cpu-large': 0.20,
    'gpu-a10g': 1.10,
    'gpu-h100': 3.50,
  };

  /**
   * Returns standard MCP Tool definition schema for LLM registration
   */
  public getDefinition(): McpToolDefinition {
    return {
      name: ComputeProvisionerTool.toolName,
      description: ComputeProvisionerTool.toolDescription,
      inputSchema: {
        type: 'object',
        properties: {
          instanceType: {
            type: 'string',
            enum: ['cpu-small', 'cpu-large', 'gpu-h100', 'gpu-a10g'],
            description: 'The type of compute instance needed.',
          },
          region: {
            type: 'string',
            default: 'us-east-1',
            description: 'Cloud deployment region.',
          },
          maxDurationHours: {
            type: 'number',
            minimum: 1,
            maximum: 72,
            description: 'Maximum runtime allocation in hours.',
          },
          maxBudgetUsd: {
            type: 'number',
            description: 'Maximum USD budget allocated for this compute session.',
          },
        },
        required: ['instanceType', 'maxDurationHours', 'maxBudgetUsd'],
      },
    };
  }

  /**
   * Executes compute provisioning with runtime Zod validation and cost guardrails
   */
  public execute(input: ProvisionComputeInput): ProvisioningResult {
    const parsed = ProvisionComputeInputSchema.parse(input);
    const hourlyRate = this.hourlyRates[parsed.instanceType];
    const estimatedTotal = Number((hourlyRate * parsed.maxDurationHours).toFixed(2));

    if (estimatedTotal > parsed.maxBudgetUsd) {
      return {
        success: false,
        totalEstimatedCostUsd: estimatedTotal,
        message: `Budget exceeded: Required $${estimatedTotal.toFixed(2)} > Max Budget $${parsed.maxBudgetUsd.toFixed(2)}`,
      };
    }

    const instanceId = `inst-${parsed.instanceType}-${Math.random().toString(36).substring(2, 9)}`;

    return {
      success: true,
      instanceId,
      hourlyRateUsd: hourlyRate,
      totalEstimatedCostUsd: estimatedTotal,
      message: `Successfully provisioned ${parsed.instanceType} in ${parsed.region} for up to ${parsed.maxDurationHours}h ($${estimatedTotal} total cap).`,
    };
  }

  /**
   * Handles direct MCP tool call response format
   */
  public handleMcpCall(args: unknown) {
    try {
      const parsed = ProvisionComputeInputSchema.parse(args);
      const result = this.execute(parsed);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.success,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  }
}

