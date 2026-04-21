from __future__ import annotations

import math

import numpy as np

from .schemas import DistributionConfig


def ResolvePositiveValue(value: float, min_value: float) -> float:
    if math.isnan(value) or math.isinf(value):
        return min_value
    return max(value, min_value)


def SampleFromDistribution(distribution: DistributionConfig, rng: np.random.Generator) -> float:
    distribution_type = distribution.distribution_type
    min_value = distribution.min_value

    if distribution_type == "normal":
        mean = distribution.mean if distribution.mean is not None else 1.0
        std = distribution.std if distribution.std is not None else 0.25
        sampled = float(rng.normal(mean, std))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "exponential":
        scale = distribution.scale if distribution.scale is not None else 1.0
        sampled = float(rng.exponential(scale))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "uniform":
        low = distribution.low if distribution.low is not None else 0.0
        high = distribution.high if distribution.high is not None else max(low + 1.0, 1.0)
        sampled = float(rng.uniform(low, high))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "deterministic":
        value = distribution.value if distribution.value is not None else 1.0
        return ResolvePositiveValue(float(value), min_value)

    raise ValueError(f"Unsupported distribution type: {distribution_type}")
