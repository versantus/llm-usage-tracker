/**
 * Carbon Calculator
 *
 * Converts token usage into energy and CO2 estimates using the Jegham et al.
 * methodology ("How Hungry is AI?", arXiv 2505.09598v6, Nov 2025).
 *
 * Vendored from CNaught's carbonlog (carbonlog-calculator.ts) and decoupled so it
 * depends only on ./types. Currently only Anthropic models have validated configs;
 * other providers fall back to a Sonnet-level estimate and should be flagged as
 * approximate (see carbonApprox on IngestEvent).
 *
 *   Energy = inference_time × (GPU_power × utilization + nonGPU_power × utilization) × PUE
 *   Carbon = Energy × CIF
 */

import type { SessionUsage, TokenUsageRecord } from './types.ts';

export interface ModelConfig {
    displayName: string;
    family: 'opus' | 'sonnet' | 'haiku' | 'unknown';
    gpuPowerKw: number;
    nonGpuPowerKw: number;
    minGpuUtilization: number;
    maxGpuUtilization: number;
    nonGpuUtilization: number;
    pue: number;
    cif: number;
    medianTps: number;
    medianTtftSeconds: number;
}

// All Anthropic models are hosted on DGX H200/H100 on AWS infrastructure.
// Hardware class: Large (8 GPUs, 5.50-7.50% GPU util, 6.25% non-GPU util)
// Source: Jegham et al. Table 1 + Artificial Analysis median benchmarks
const ANTHROPIC_LARGE_BASE = {
    gpuPowerKw: 5.6,
    nonGpuPowerKw: 4.6,
    minGpuUtilization: 0.055,
    maxGpuUtilization: 0.075,
    nonGpuUtilization: 0.0625,
    pue: 1.14,
    cif: 0.3
} as const;

const MODEL_CONFIGS: Record<string, ModelConfig> = {
    'claude-3-haiku-20240307': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude 3 Haiku',
        family: 'haiku',
        medianTps: 109,
        medianTtftSeconds: 0.37
    },
    'claude-3-5-haiku-20241022': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude 3.5 Haiku',
        family: 'haiku',
        medianTps: 70,
        medianTtftSeconds: 0.54
    },
    'claude-haiku-4-5-20251001': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude 4.5 Haiku',
        family: 'haiku',
        medianTps: 148,
        medianTtftSeconds: 0.52
    },
    'claude-sonnet-4-20250514': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude Sonnet 4',
        family: 'sonnet',
        medianTps: 75,
        medianTtftSeconds: 1.01
    },
    'claude-sonnet-4-5-20250929': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude 4.5 Sonnet',
        family: 'sonnet',
        medianTps: 81,
        medianTtftSeconds: 1.27
    },
    'claude-opus-4-20250514': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude Opus 4',
        family: 'opus',
        medianTps: 55,
        medianTtftSeconds: 1.19
    },
    'claude-opus-4-1-20250805': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude Opus 4.1',
        family: 'opus',
        medianTps: 58,
        medianTtftSeconds: 1.38
    },
    // Versionless entries — any dated variant (e.g. claude-opus-4-5-20251101) maps here
    'claude-opus-4-5': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude Opus 4.5',
        family: 'opus',
        medianTps: 78,
        medianTtftSeconds: 1.33
    },
    'claude-opus-4-6': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude Opus 4.6',
        family: 'opus',
        medianTps: 69,
        medianTtftSeconds: 1.73
    },
    'claude-sonnet-4-6': {
        ...ANTHROPIC_LARGE_BASE,
        displayName: 'Claude Sonnet 4.6',
        family: 'sonnet',
        medianTps: 59,
        medianTtftSeconds: 0.88
    }
};

const FAMILY_DEFAULTS: Record<string, ModelConfig> = {
    haiku: { ...MODEL_CONFIGS['claude-haiku-4-5-20251001'], displayName: 'Unknown Haiku' },
    sonnet: { ...MODEL_CONFIGS['claude-sonnet-4-5-20250929'], displayName: 'Unknown Sonnet' },
    opus: { ...MODEL_CONFIGS['claude-opus-4-1-20250805'], displayName: 'Unknown Opus' }
};

const DEFAULT_MODEL_CONFIG: ModelConfig = {
    ...FAMILY_DEFAULTS.sonnet,
    displayName: 'Unknown Model',
    family: 'unknown'
};

/**
 * Get model configuration by API model ID.
 * Falls back to family-based config, then to Sonnet-level defaults.
 */
export function getModelConfig(modelId: string): ModelConfig {
    if (MODEL_CONFIGS[modelId]) {
        return MODEL_CONFIGS[modelId];
    }

    const versionless = modelId.replace(/-\d{8}$/, '');
    if (versionless !== modelId && MODEL_CONFIGS[versionless]) {
        return MODEL_CONFIGS[versionless];
    }

    const lowerModel = modelId.toLowerCase();
    if (lowerModel.includes('opus')) {
        return { ...FAMILY_DEFAULTS.opus, family: 'opus' };
    }
    if (lowerModel.includes('sonnet')) {
        return { ...FAMILY_DEFAULTS.sonnet, family: 'sonnet' };
    }
    if (lowerModel.includes('haiku')) {
        return { ...FAMILY_DEFAULTS.haiku, family: 'haiku' };
    }

    return DEFAULT_MODEL_CONFIG;
}

/**
 * Returns true when we have a validated config for this model ID.
 * Non-Anthropic / unknown models use a fallback estimate that callers should
 * mark as approximate.
 */
export function isCarbonApproximate(modelId: string): boolean {
    if (MODEL_CONFIGS[modelId]) return false;
    const versionless = modelId.replace(/-\d{8}$/, '');
    if (versionless !== modelId && MODEL_CONFIGS[versionless]) return false;
    return true;
}

export interface EnergyResult {
    energyWh: number;
    energyKwh: number;
}

export interface CarbonResult {
    energy: EnergyResult;
    co2Grams: number;
    co2Kg: number;
    modelBreakdown: Record<string, { energyWh: number; co2Grams: number }>;
}

/**
 * Calculate per-query energy consumption using Jegham Equations 1-2.
 */
export function calculateEnergy(
    outputTokens: number,
    modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG
): EnergyResult {
    const inferenceTimeHours =
        (modelConfig.medianTtftSeconds + outputTokens / modelConfig.medianTps) / 3600;

    const powerMinKw =
        modelConfig.gpuPowerKw * modelConfig.minGpuUtilization +
        modelConfig.nonGpuPowerKw * modelConfig.nonGpuUtilization;
    const powerMaxKw =
        modelConfig.gpuPowerKw * modelConfig.maxGpuUtilization +
        modelConfig.nonGpuPowerKw * modelConfig.nonGpuUtilization;

    const energyMinWh = inferenceTimeHours * powerMinKw * modelConfig.pue * 1000;
    const energyMaxWh = inferenceTimeHours * powerMaxKw * modelConfig.pue * 1000;

    const energyWh = 0.5 * energyMaxWh + 0.5 * energyMinWh;

    return { energyWh, energyKwh: energyWh / 1000 };
}

export function calculateCO2FromEnergy(
    energyWh: number,
    modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG
): number {
    return energyWh * modelConfig.cif;
}

export function calculateRecordCarbon(record: TokenUsageRecord): CarbonResult {
    const modelConfig = getModelConfig(record.model);
    const energy = calculateEnergy(record.outputTokens, modelConfig);
    const co2Grams = calculateCO2FromEnergy(energy.energyWh, modelConfig);

    return {
        energy,
        co2Grams,
        co2Kg: co2Grams / 1000,
        modelBreakdown: {
            [modelConfig.family]: { energyWh: energy.energyWh, co2Grams }
        }
    };
}

/**
 * Calculate carbon emissions for an entire session.
 * Iterates over individual records so each API request gets its own TTFT cost.
 */
export function calculateSessionCarbon(session: SessionUsage): CarbonResult {
    const modelBreakdown: Record<string, { energyWh: number; co2Grams: number }> = {};
    let totalEnergyWh = 0;
    let totalCO2 = 0;

    for (const record of session.records) {
        const result = calculateRecordCarbon(record);

        totalEnergyWh += result.energy.energyWh;
        totalCO2 += result.co2Grams;

        const family = getModelConfig(record.model).family;
        if (!modelBreakdown[family]) {
            modelBreakdown[family] = { energyWh: 0, co2Grams: 0 };
        }
        modelBreakdown[family].energyWh += result.energy.energyWh;
        modelBreakdown[family].co2Grams += result.co2Grams;
    }

    return {
        energy: { energyWh: totalEnergyWh, energyKwh: totalEnergyWh / 1000 },
        co2Grams: totalCO2,
        co2Kg: totalCO2 / 1000,
        modelBreakdown
    };
}

/**
 * Approximate carbon from a single aggregate output-token count.
 * Used for providers (e.g. Codex CLI) that only expose aggregate tokens.
 */
export function calculateCarbonFromTokens(
    outputTokens: number,
    model = 'unknown'
): CarbonResult {
    const modelConfig = getModelConfig(model);
    const energy = calculateEnergy(outputTokens, modelConfig);
    const co2Grams = calculateCO2FromEnergy(energy.energyWh, modelConfig);

    return {
        energy,
        co2Grams,
        co2Kg: co2Grams / 1000,
        modelBreakdown: {
            [modelConfig.family]: { energyWh: energy.energyWh, co2Grams }
        }
    };
}

// Carbon equivalents (EPA: 1 gal gasoline = 8.887 kgCO2, avg 22.4 mpg)
export const MPG = 22.4;
export const GALLONS_PER_KG_CO2 = 1 / 8.887;
export const MILES_PER_KG_CO2 = MPG * GALLONS_PER_KG_CO2;

export function formatCO2(grams: number): string {
    if (grams < 0.01) return '< 0.01g';
    if (grams < 1000) return `${grams.toFixed(2)}g`;
    return `${(grams / 1000).toFixed(3)}kg`;
}

export function formatEnergy(wh: number): string {
    if (wh < 0.001) return '< 0.001 Wh';
    if (wh < 1) return `${wh.toFixed(3)} Wh`;
    if (wh < 1000) return `${wh.toFixed(2)} Wh`;
    return `${(wh / 1000).toFixed(3)} kWh`;
}
