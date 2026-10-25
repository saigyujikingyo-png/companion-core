"""Original, bounded FlyWire v783 data reader; no network or production data access."""
from __future__ import annotations

import csv
import hashlib
import json
from collections import Counter
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

SOURCES = {
    "annotations.tsv": "30be6c73975a70c56d930e27911f36455d3886e15abf383b78edd2a5d679e0b6",
    "Connectivity_783.parquet": "efeb23fb99098e9c390f6869969b2a121a2ee92c833cfc45ecb2c1d8e1af0347",
    "Completeness_783.csv": "bbb847a4cc2caaa7a16349722d220c087317b946d148d4d592d94d250617a311",
}
NODE_HASH = "0a29fea2930e0ca9881d4bced69e085a74eeee664c6470c2f54371f87e694a83"
MBON11 = 720575940623201833
PPL101 = 720575940621040737
APL = 720575940624547622
COLUMNS = ("Presynaptic_ID", "Postsynaptic_ID", "Presynaptic_Index", "Postsynaptic_Index",
           "Connectivity", "Excitatory", "Excitatory x Connectivity", "__index_level_0__")


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def object_hash(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


@dataclass
class Graph:
    ids: np.ndarray
    classes: np.ndarray
    pre: np.ndarray
    post: np.ndarray
    count: np.ndarray
    sign: np.ndarray
    source_row: np.ndarray
    metadata: dict

    @property
    def n(self) -> int:
        return len(self.ids)

    @property
    def signed(self) -> np.ndarray:
        return self.count * self.sign

    def digest(self) -> str:
        digest = hashlib.sha256(b"companion-flywire-subgraph-v1\0")
        for name in ("ids", "pre", "post", "count", "sign", "source_row"):
            a = np.asarray(getattr(self, name), dtype="<i8")
            digest.update(canonical([name, list(a.shape), "int64-le"]))
            digest.update(a.tobytes())
        digest.update(canonical(self.classes.tolist()))
        return digest.hexdigest()

    def validate(self) -> None:
        if len(set(map(int, self.ids))) != self.n or self.ids.dtype != np.int64:
            raise ValueError("root IDs must be unique int64, never floating point")
        if len(self.classes) != self.n or not all(len(a) == len(self.pre) for a in
                (self.post, self.count, self.sign, self.source_row)):
            raise ValueError("inconsistent graph arrays")
        if np.any(self.pre < 0) or np.any(self.post < 0) or np.any(self.pre >= self.n) or np.any(self.post >= self.n):
            raise ValueError("edge index out of bounds")
        if np.any(self.count <= 0) or not np.isin(self.sign, [-1, 0, 1]).all():
            raise ValueError("invalid contact counts or signs")
        if len(np.unique(self.pre * self.n + self.post)) != len(self.pre):
            raise ValueError("expected unique directed aggregate edges")

    def save(self, path: Path) -> None:
        with path.open("xb") as stream:
            np.savez_compressed(stream, ids=self.ids, classes=self.classes, pre=self.pre,
                                post=self.post, count=self.count, sign=self.sign,
                                signed=self.signed, source_row=self.source_row)


def validate_index_mapping(a: dict[str, np.ndarray], all_ids: np.ndarray) -> None:
    for prefix in ("Presynaptic", "Postsynaptic"):
        idx = a[f"{prefix}_Index"]
        if np.any(idx < 0) or np.any(idx >= len(all_ids)):
            raise ValueError("source global index out of bounds")
        if not np.array_equal(all_ids[idx], a[f"{prefix}_ID"]):
            raise ValueError("source root ID / completeness index mismatch")
    if not np.array_equal(a["Connectivity"] * a["Excitatory"], a["Excitatory x Connectivity"]):
        raise ValueError("source signed weights differ from count times sign")


def load_graph(directory: Path) -> Graph:
    observed = {name: sha_file(directory / name) for name in SOURCES}
    if observed != SOURCES:
        raise ValueError(f"fixed-source hash mismatch: {observed}")
    with (directory / "annotations.tsv").open(encoding="utf-8", newline="") as stream:
        selected = [r for r in csv.DictReader(stream, delimiter="\t")
                    if r["side"] == "left" and (r["cell_class"] in
                       ("ALPN", "Kenyon_Cell", "MBON", "DAN") or
                       (r["cell_class"] == "MBIN" and r["hemibrain_type"] == "APL"))]
    selected.sort(key=lambda row: int(row["root_id"]))
    ids = np.array([int(row["root_id"]) for row in selected], dtype=np.int64)
    classes = np.array(["APL" if row["hemibrain_type"] == "APL" else row["cell_class"]
                        for row in selected])
    node_hash = hashlib.sha256(("\n".join(map(str, ids)) + "\n").encode()).hexdigest()
    if len(ids) != 3136 or node_hash != NODE_HASH:
        raise ValueError("left mushroom-body selection differs from frozen specification")
    with (directory / "Completeness_783.csv").open(encoding="utf-8", newline="") as stream:
        all_ids = np.array([int(row[""]) for row in csv.DictReader(stream)], dtype=np.int64)
    if len(all_ids) != 138639 or len(np.unique(all_ids)) != len(all_ids) or not np.isin(ids, all_ids).all():
        raise ValueError("completeness universe mismatch")
    blocks = {name: [] for name in COLUMNS}
    source = pq.ParquetFile(directory / "Connectivity_783.parquet")
    total = 0
    for batch in source.iter_batches(batch_size=131072, columns=list(COLUMNS)):
        a = {name: batch.column(name).to_numpy() for name in COLUMNS}
        validate_index_mapping(a, all_ids)
        keep = np.isin(a["Presynaptic_ID"], ids) & np.isin(a["Postsynaptic_ID"], ids)
        for name in COLUMNS:
            blocks[name].append(a[name][keep].copy())
        total += len(batch)
    if total != 15091983:
        raise ValueError("unexpected whole-connectome row count")
    chosen = {name: np.concatenate(parts) for name, parts in blocks.items()}
    # IDs remain integer and searchsorted is exact above JavaScript's integer range.
    pre = np.searchsorted(ids, chosen["Presynaptic_ID"])
    post = np.searchsorted(ids, chosen["Postsynaptic_ID"])
    graph = Graph(ids, classes, pre, post, chosen["Connectivity"], chosen["Excitatory"],
                  chosen["__index_level_0__"], {})
    graph.validate()
    graph.metadata = {
        "sourceSha256": observed, "nodeIdSha256": node_hash, "nodes": graph.n,
        "edges": len(pre), "globalRowsValidated": total, "globalIdIndexMismatches": 0,
        "classes": dict(Counter(classes.tolist())),
        "zeroSignedEdges": int(np.count_nonzero(graph.signed == 0)),
        "danOutgoingEdges": int(np.count_nonzero(classes[pre] == "DAN")),
        "kcMbon11Edges": int(np.count_nonzero((classes[pre] == "Kenyon_Cell") & (ids[post] == MBON11))),
        "ppl101SourceSigns": sorted(set(map(int, graph.sign[ids[pre] == PPL101]))),
        "orientation": "W[postsynaptic, presynaptic]",
        "selection": "left ALPN/Kenyon_Cell/MBON/DAN plus MBIN hemibrain_type exactly APL",
        "sourceCodeCommit": "91bdd1e7dcf193f3e7ca5a8933497fcef63b7960",
        "annotationCommit": "ebd66db2596fcc39c6950fb54ea3efa00f7fe8a0",
        "license": "FlyWire CC BY-NC 4.0; local noncommercial research; no redistribution in this repo",
        "sourceDataCaveat": "This fixed parquet assigns DAN +1. It is retained, not proof of receptor physiology.",
    }
    graph.metadata["structuralSha256"] = graph.digest()
    return graph


def degree_preserving_rewire(graph: Graph, seed: int) -> Graph:
    """Directed swaps within source/destination class and source sign strata.

    Preserves each node's unweighted in/out degree in every stratum; contact
    counts remain tied to source edges. Does NOT preserve weighted input
    strength, spatial position, motifs, or the biological meaning of each edge.
    """
    rng = np.random.default_rng(seed)
    post = graph.post.copy()
    groups: dict[tuple, list[int]] = {}
    for i, (a, b, sign) in enumerate(zip(graph.pre, post, graph.sign)):
        groups.setdefault((str(graph.classes[a]), str(graph.classes[b]), int(sign)), []).append(i)
    pairs = set(map(int, graph.pre * graph.n + post))
    swaps = 0
    for entries in groups.values():
        idx = np.array(entries, dtype=np.int64)
        if len(idx) < 2:
            continue
        for i, j in rng.choice(idx, size=(2 * len(idx), 2), replace=True):
            a, b, c, d = int(graph.pre[i]), int(post[i]), int(graph.pre[j]), int(post[j])
            if a == c or b == d or a * graph.n + d in pairs or c * graph.n + b in pairs:
                continue
            pairs.remove(a * graph.n + b)
            pairs.remove(c * graph.n + d)
            pairs.add(a * graph.n + d)
            pairs.add(c * graph.n + b)
            post[i], post[j] = d, b
            swaps += 1
    result = replace(graph, post=post, metadata=dict(graph.metadata))
    result.validate()
    if not np.array_equal(np.bincount(post, minlength=graph.n), np.bincount(graph.post, minlength=graph.n)):
        raise AssertionError("rewiring changed in-degree")
    result.metadata.update({"rewireSeed": seed, "acceptedSwaps": swaps,
                            "rewiredEdges": int(np.count_nonzero(post != graph.post)),
                            "rewireScope": "directed class-pair and sign-stratified simple-edge swaps; unweighted in/out degrees",
                            "structuralSha256": result.digest()})
    return result
