"""Event-only CPU FlyWire prior prototype. No training, personal text, disk writes or network."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
FROZEN = {
    "connectome.py": "00373956d3ec2f2c05da5e5481b070dfef8be1bfc1874a124fcaf8d573a4511f",
    "circuit.py": "8453434fb1b8615560a2ca6ccc584ae872eae0b4516e7576e7763c89f31599a0",
    "run_experiment.py": "b55dcc2511fcc9c52ee82646f8a8edd9223afbe0e5286a9160ed03e93fa444dc",
}
CODEC = "prior-v1:ALPN-index-mod3;8-event-steps;carry-exp-dt/60000;MBON-index-mod3-tanh5;no-learning"
MIN_FREE_BYTES = 1536 * 1024**2


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def emit(value):
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    if len(payload) > 8192:
        raise ValueError("OUTPUT_LIMIT")
    print(payload, flush=True)


class PriorEngine:
    def __init__(self, graph, condition):
        import torch
        from circuit import RateCircuit
        self.torch = torch
        self.model = RateCircuit(graph).eval()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        self.condition = condition
        self.h = torch.zeros((graph.n, 1))
        self.simple = torch.zeros((3,))
        self.delta = self.model.edge_delta()
        self.events = 0

    def reset(self):
        self.h.zero_()
        self.simple.zero_()
        self.events = 0

    def step(self, dt_ms, features):
        torch = self.torch
        if not isinstance(dt_ms, (int, float)) or not math.isfinite(dt_ms) or not 0 <= dt_ms <= 300000:
            raise ValueError("INVALID_DT")
        if not isinstance(features, dict) or set(features) != {"social", "novelty", "disengagement"}:
            raise ValueError("INVALID_FEATURES")
        values = [features[name] for name in ("social", "novelty", "disengagement")]
        if any(type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 1 for x in values):
            raise ValueError("INVALID_FEATURES")
        before = float(torch.linalg.vector_norm(self.h).item())
        decay = math.exp(-dt_ms / 60000)
        with torch.no_grad():
            self.h.mul_(decay)
            self.simple.mul_(decay)
            feature = torch.tensor(values, dtype=torch.float32)
            # ALPN ordering is pinned by the source graph identity. Channel names
            # are an authored engineering codec, not neuronal affect labels.
            encoded = feature[torch.arange(len(self.model.alpn)) % 3]
            drive = torch.zeros_like(self.h).index_add(0, self.model.alpn, encoded[:, None])
            for _ in range(8):
                if self.condition == "real":
                    self.h = self.model.advance(self.h, drive, self.delta)
                else:
                    self.h = 0.75 * self.h + 0.25 * drive
                self.simple = 0.75 * self.simple + 0.25 * feature
            if not torch.isfinite(self.h).all():
                raise ValueError("NONFINITE_STATE")
            if self.condition == "real":
                output = self.h[self.model.mbon, 0]
                readout = [float(torch.tanh(output[i::3].mean() * 5).item()) if len(output[i::3]) else 0.0 for i in range(3)]
            else:
                readout = [float(torch.tanh(x * 5).item()) for x in self.simple]
        self.events += 1
        return {"prior": dict(zip(("social", "novelty", "disengagement"), readout)),
                "events": self.events, "carryNormBefore": before,
                "stateL2": float(torch.linalg.vector_norm(self.h).item()), "steps": 8}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--graph-sha256", required=True)
    parser.add_argument("--structural-sha256", required=True)
    parser.add_argument("--condition", choices=("real", "no-circuit"), default="real")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    if any(sha(here / name) != expected for name, expected in FROZEN.items()):
        raise ValueError("FROZEN_SOURCE_MISMATCH")
    if not args.graph.is_absolute() or args.graph.stat().st_size > 64 * 1024**2 or sha(args.graph) != args.graph_sha256:
        raise ValueError("GRAPH_ARCHIVE_MISMATCH")
    with zipfile.ZipFile(args.graph) as archive:
        members = archive.infolist()
        expected = {name + ".npy" for name in ("ids", "classes", "pre", "post", "count", "sign", "signed", "source_row")}
        if len(members) != len(expected) or {entry.filename for entry in members} != expected or any(entry.flag_bits & 1 for entry in members) or sum(entry.file_size for entry in members) > 32 * 1024**2:
            raise ValueError("GRAPH_UNCOMPRESSED_LIMIT")
    import psutil
    if psutil.virtual_memory().available < MIN_FREE_BYTES:
        raise RuntimeError("RESOURCE_REFUSAL_BEFORE_TORCH")
    import numpy as np
    import torch
    from connectome import Graph
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    if psutil.virtual_memory().available < MIN_FREE_BYTES:
        raise RuntimeError("RESOURCE_REFUSAL_AFTER_IMPORT")
    with np.load(args.graph, allow_pickle=False) as archive:
        graph = Graph(*(archive[name] for name in ("ids", "classes", "pre", "post", "count", "sign", "source_row")), {})
    graph.validate()
    if graph.n != 3136 or len(graph.pre) > 500000 or graph.digest() != args.structural_sha256:
        raise ValueError("GRAPH_STRUCTURE_MISMATCH")
    engine = PriorEngine(graph, args.condition)
    emit({"version": 1, "event": "ready", "manifest": {
        "implementation": "flywire-prior-jsonl-v1", "sourceHash": sha(Path(__file__)), "biologicalClaim": "none",
        "frozenSources": FROZEN, "codec": CODEC, "condition": args.condition, "device": "cpu",
        "nodes": graph.n, "edges": len(graph.pre), "graphSha256": args.graph_sha256,
        "structuralSha256": graph.digest(), "freeHostBytes": psutil.virtual_memory().available,
        "python": sys.version.split()[0], "torch": torch.__version__, "threads": 2}})
    seen = set()
    for _ in range(256):
        raw = sys.stdin.buffer.readline(4097)
        if not raw:
            return
        if len(raw) > 4096 or not raw.endswith(b"\n"):
            raise ValueError("INPUT_LIMIT")
        started = time.monotonic()
        request = json.loads(raw)
        if not isinstance(request, dict) or type(request.get("version")) is not int or request.get("version") != 1 or set(request) - {"version", "id", "command", "dtMs", "features", "maxMs"}:
            raise ValueError("INVALID_REQUEST")
        identity = request.get("id")
        if not isinstance(identity, str) or not 1 <= len(identity) <= 128 or identity in seen:
            raise ValueError("DUPLICATE_OR_INVALID_ID")
        seen.add(identity)
        maximum = request.get("maxMs")
        if type(maximum) is not int or not 1 <= maximum <= 5000:
            raise ValueError("INVALID_DEADLINE")
        if request.get("command") == "stop":
            emit({"version": 1, "id": identity, "event": "stopped"})
            return
        if request.get("command") == "reset":
            engine.reset()
            result = {"event": "reset"}
        elif request.get("command") == "step":
            if psutil.virtual_memory().available < MIN_FREE_BYTES:
                raise RuntimeError("RESOURCE_REFUSAL_AT_EVENT")
            result = {"event": "result", **engine.step(request.get("dtMs"), request.get("features"))}
        else:
            raise ValueError("UNKNOWN_COMMAND")
        if (time.monotonic() - started) * 1000 >= maximum:
            raise TimeoutError("EVENT_DEADLINE")
        emit({"version": 1, "id": identity, **result})
    raise ValueError("SESSION_EVENT_CAPACITY")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Only bounded generic error names, never input/personal text or paths.
        label = str(error)
        code = label if 1 <= len(label) <= 64 and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789" for c in label) else type(error).__name__
        emit({"version": 1, "event": "error", "code": code})
        sys.exit(1)
