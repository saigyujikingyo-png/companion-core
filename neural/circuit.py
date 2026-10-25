"""Research rate dynamics, not Shiu's LIF implementation or a biological replica."""
from __future__ import annotations

import numpy as np
import torch
from torch import nn

from connectome import Graph, MBON11, PPL101

DEFAULT_CONFIG = {
    "operatorVersion": "rate-coo-delta-v1", "timeUnit": "dimensionless engineering step",
    "leakAlpha": 0.25, "recurrentGain": 0.90, "rateCeiling": 10.0,
    "normalization": "fixed per-postsynaptic sum(abs(source signed weights)); zero rows divide by 1",
    "danFastDynamics": "retain source signs including +1; no receptor-physiology claim",
    "readoutScale": 25.0, "edgeGain": "1 + 0.5*tanh(theta); real KC->MBON edges only",
    "localRule": "KC eligibility times explicit external PPL101 gate; bounded LTD on KC->MBON11 only",
    "localEta": 0.35, "localFloor": 0.20, "eligibilityDecay": 0.90,
}


class RateCircuit(nn.Module):
    def __init__(self, graph: Graph, *, train_edges: bool = False, config: dict | None = None):
        super().__init__()
        self.config = dict(DEFAULT_CONFIG if config is None else config)
        self.n = graph.n
        self.structural_hash = graph.digest()
        row_sum = np.bincount(graph.post, weights=np.abs(graph.signed), minlength=graph.n)
        values = (graph.signed / np.maximum(row_sum[graph.post], 1)).astype(np.float32)
        indices = torch.tensor(np.stack((graph.post, graph.pre)), dtype=torch.long)
        self.register_buffer("base", torch.sparse_coo_tensor(indices, torch.tensor(values),
                             (graph.n, graph.n), check_invariants=True).coalesce(), persistent=False)
        selected = (graph.classes[graph.pre] == "Kenyon_Cell") & (graph.classes[graph.post] == "MBON")
        local = selected & (graph.ids[graph.post] == MBON11)
        self.register_buffer("plastic_pre", torch.tensor(graph.pre[selected], dtype=torch.long), persistent=False)
        self.register_buffer("plastic_post", torch.tensor(graph.post[selected], dtype=torch.long), persistent=False)
        self.register_buffer("plastic_base", torch.tensor(values[selected]), persistent=False)
        self.register_buffer("local_mask", torch.tensor(local[selected]), persistent=False)
        self.register_buffer("alpn", torch.tensor(np.flatnonzero(graph.classes == "ALPN")), persistent=False)
        self.register_buffer("mbon", torch.tensor(np.flatnonzero(graph.classes == "MBON")), persistent=False)
        self.register_buffer("ppl", torch.tensor(np.flatnonzero(graph.ids == PPL101)), persistent=False)
        self.register_buffer("local_gain", torch.ones(int(selected.sum())))
        self.theta = nn.Parameter(torch.zeros(int(selected.sum())), requires_grad=train_edges)
        self.readout = nn.Linear(len(self.mbon), 2)

    def edge_delta(self) -> torch.Tensor:
        gain = (1 + 0.5 * torch.tanh(self.theta)) * self.local_gain
        return self.plastic_base * (gain - 1)

    def advance(self, h: torch.Tensor, drive: torch.Tensor, delta: torch.Tensor) -> torch.Tensor:
        propagated = torch.sparse.mm(self.base, h)
        correction = torch.zeros_like(h).index_add(0, self.plastic_post,
                     h[self.plastic_pre] * delta[:, None])
        target = torch.relu((propagated + correction) * self.config["recurrentGain"] + drive)
        target = torch.clamp(target, max=self.config["rateCeiling"])
        alpha = self.config["leakAlpha"]
        return (1 - alpha) * h + alpha * target

    def rollout(self, inputs: torch.Tensor, *, trace: bool = False):
        # input is [steps, batch, ALPN]; all neural arithmetic stays on its device.
        if inputs.ndim != 3 or inputs.shape[2] != len(self.alpn):
            raise ValueError("expected [steps, batch, selected ALPN] inputs")
        h = inputs.new_zeros((self.n, inputs.shape[1]))
        delta = self.edge_delta()
        recorded = []
        for stimulus in inputs:
            drive = torch.zeros_like(h).index_add(0, self.alpn, stimulus.T)
            h = self.advance(h, drive, delta)
            if trace:
                recorded.append(h)
        return (h, torch.stack(recorded)) if trace else h

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        h = self.rollout(inputs)
        return self.readout(h[self.mbon].T * self.config["readoutScale"])

    def frozen_features(self, inputs: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            return self.rollout(inputs)[self.mbon].T * self.config["readoutScale"]

    @torch.no_grad()
    def local_pair(self, inputs: torch.Tensor, gate: float) -> dict:
        if not 0 <= gate <= 1:
            raise ValueError("PPL101 gate must be in [0,1]")
        if len(self.ppl) != 1 or not self.local_mask.any():
            raise ValueError("specified PPL101/MBON11 circuit unavailable")
        h = inputs.new_zeros((self.n, inputs.shape[1]))
        eligibility = inputs.new_zeros(len(self.plastic_pre))
        before = self.local_gain.clone()
        for stimulus in inputs:
            drive = torch.zeros_like(h).index_add(0, self.alpn, stimulus.T)
            h = self.advance(h, drive, self.edge_delta())
            # The external reward is assigned to the named PPL101 plasticity
            # channel. It is not secretly injected as a fast excitatory stimulus.
            odor = (stimulus.abs().sum(dim=1) > 0).to(h.dtype)
            eligibility.mul_(self.config["eligibilityDecay"])
            eligibility.add_((h[self.plastic_pre] * odor[None, :]).mean(dim=1))
            depression = self.config["localEta"] * gate * eligibility * self.local_mask
            self.local_gain.sub_(depression).clamp_(self.config["localFloor"], 1)
        difference = before - self.local_gain
        return {"changedEdges": int(torch.count_nonzero(difference).item()),
                "maxDepression": float(difference.max().item()),
                "totalDepression": float(difference.sum().item()),
                "finite": bool(torch.isfinite(h).all().item()),
                "onlyMbon11Changed": bool(torch.all(difference[~self.local_mask] == 0).item())}


class NoCircuit(nn.Module):
    """Same full stimulus sequence, time average, trainable linear readout."""
    def __init__(self, inputs: int):
        super().__init__()
        self.readout = nn.Linear(inputs, 2)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.readout(inputs.mean(dim=0))


def make_stimuli(seed: int, samples: int, steps: int, inputs: int,
                 *, split: str) -> tuple[torch.Tensor, torch.Tensor, dict]:
    """Four fixed synthetic ALPN odors; held-out noise, never real observations.

    All conditions receive identical arrays. Identity is shown for the first
    quarter of the sequence and read out after the delay; labels alternate.
    """
    prototype_rng = np.random.default_rng(seed)
    order = prototype_rng.permutation(inputs)
    prototypes = np.zeros((4, inputs), dtype=np.float32)
    width = max(1, min(32, inputs // 4))
    for label in range(4):
        prototypes[label, order[label * width:(label + 1) * width]] = 1.0
    rng = np.random.default_rng(seed + (1000003 if split == "heldout" else 2000003))
    odor_ids = np.arange(samples, dtype=np.int64) % 4
    rng.shuffle(odor_ids)
    x = np.zeros((steps, samples, inputs), dtype=np.float32)
    onset = max(1, steps // 4)
    noise = rng.uniform(0.85, 1.15, size=(onset, samples, inputs)).astype(np.float32)
    x[:onset] = prototypes[odor_ids][None, :, :] * noise
    y = odor_ids % 2
    return torch.from_numpy(x), torch.from_numpy(y), {
        "seed": seed, "split": split, "samples": samples, "steps": steps,
        "odorWidth": width, "odorOnsetSteps": onset,
        "task": "synthetic four-odor delayed binary identity; heldout multiplicative noise; not biological behavior",
    }
