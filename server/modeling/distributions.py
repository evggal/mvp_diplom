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

    if distribution_type == "poisson":
        # For a Poisson arrival process we sample interarrival delay
        # from the equivalent exponential law with parameter lambda = rate.
        rate = distribution.rate
        if rate is None:
            rate = distribution.intensity
        if rate is None:
            rate = distribution.value
        safe_rate = rate if rate is not None and rate > 0 else 1.0
        sampled = float(rng.exponential(1.0 / safe_rate))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "erlang":
        shape = distribution.shape if distribution.shape is not None and distribution.shape > 0 else 2
        rate = distribution.rate
        if rate is None:
            rate = distribution.intensity
        safe_rate = rate if rate is not None and rate > 0 else 1.0
        sampled = float(rng.gamma(shape, 1.0 / safe_rate))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "hyperexponential":
        mix_probability = (
            distribution.mix_probability
            if distribution.mix_probability is not None
            else 0.5
        )
        mix_probability = min(1.0, max(0.0, mix_probability))
        rate1 = distribution.rate1 if distribution.rate1 is not None and distribution.rate1 > 0 else 1.2
        rate2 = distribution.rate2 if distribution.rate2 is not None and distribution.rate2 > 0 else 0.6
        picked_rate = rate1 if rng.uniform(0.0, 1.0) <= mix_probability else rate2
        sampled = float(rng.exponential(1.0 / picked_rate))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "intervals":
        intervals = distribution.intervals
        if not intervals and distribution.value is not None:
            intervals = [distribution.value]
        valid_intervals = [item for item in (intervals or []) if item > 0]
        if not valid_intervals:
            valid_intervals = [1.0]
        sampled = float(rng.choice(valid_intervals))
        return ResolvePositiveValue(sampled, min_value)

    if distribution_type == "intensity":
        intensity = distribution.intensity
        if intensity is None:
            intensity = distribution.rate
        if intensity is None:
            intensity = distribution.value
        safe_intensity = intensity if intensity is not None and intensity > 0 else 1.0
        sampled = float(rng.exponential(1.0 / safe_intensity))
        return ResolvePositiveValue(sampled, min_value)

    raise ValueError(f"Unsupported distribution type: {distribution_type}")
