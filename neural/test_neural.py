"""Synthetic CPU unit checks. These do not qualify physical GPU execution."""
import copy
import hashlib
import json
import unittest

import numpy as np
import torch

from circuit import DEFAULT_CONFIG, RateCircuit, make_stimuli
from connectome import Graph, MBON11, PPL101, degree_preserving_rewire, validate_index_mapping
from run_experiment import workload_hash


def fixture() -> Graph:
    graph = Graph(np.array([1, 2, 3, MBON11, PPL101], dtype=np.int64),
                  np.array(["ALPN", "Kenyon_Cell", "Kenyon_Cell", "MBON", "DAN"]),
                  np.array([0, 0, 1, 2, 3, 4]), np.array([1, 2, 3, 3, 1, 1]),
                  np.array([3, 2, 4, 1, 1, 2]), np.array([1, 1, 1, 1, -1, 1]),
                  np.arange(6), {})
    graph.validate()
    return graph


class NeuralTests(unittest.TestCase):
    def test_rate_orientation_matches_independent_dense_recurrence(self):
        graph = fixture()
        circuit = RateCircuit(graph)
        x = torch.ones(9, 2, 1)
        actual = circuit.rollout(x).detach().numpy()
        matrix = np.zeros((graph.n, graph.n), dtype=np.float64)
        matrix[graph.post, graph.pre] = graph.signed
        matrix /= np.maximum(np.abs(matrix).sum(axis=1), 1)[:, None]
        h = np.zeros((graph.n, 2))
        for _ in range(9):
            drive = np.zeros_like(h)
            drive[0] = 1
            target = np.clip(matrix @ h * DEFAULT_CONFIG["recurrentGain"] + drive, 0, 10)
            h = 0.75 * h + 0.25 * target
        np.testing.assert_allclose(actual, h, atol=1e-7, rtol=1e-6)

    def test_local_rule_requires_odor_and_gate_and_targets_real_edges(self):
        circuit = RateCircuit(fixture())
        x = torch.ones(12, 2, 1)
        before = copy.deepcopy(circuit.state_dict())
        self.assertEqual(circuit.local_pair(x, 0)["changedEdges"], 0)
        self.assertEqual(circuit.local_pair(torch.zeros_like(x), 1)["changedEdges"], 0)
        result = circuit.local_pair(x, 1)
        self.assertGreater(result["changedEdges"], 0)
        self.assertTrue(result["onlyMbon11Changed"])
        self.assertTrue(torch.all(circuit.local_gain >= DEFAULT_CONFIG["localFloor"]))
        self.assertTrue(torch.equal(circuit.theta, before["theta"]))
        self.assertTrue(torch.equal(circuit.readout.weight, before["readout.weight"]))

    def test_bptt_changes_circuit_edges_not_only_readout(self):
        torch.manual_seed(10)
        circuit = RateCircuit(fixture(), train_edges=True)
        before = circuit.theta.detach().clone()
        x = torch.ones(12, 2, 1)
        loss = torch.nn.functional.cross_entropy(circuit(x), torch.tensor([0, 0]))
        loss.backward()
        self.assertTrue(torch.isfinite(circuit.theta.grad).all())
        self.assertTrue((circuit.theta.grad != 0).any())
        torch.optim.Adam(circuit.parameters(), lr=0.03).step()
        self.assertFalse(torch.equal(before, circuit.theta))
        self.assertTrue(torch.all(1 + 0.5 * torch.tanh(circuit.theta) > 0))

    def test_bad_source_index_or_signed_weight_rejected(self):
        all_ids = np.array([MBON11, PPL101], dtype=np.int64)
        data = {"Presynaptic_Index": np.array([0]), "Postsynaptic_Index": np.array([1]),
                "Presynaptic_ID": all_ids[:1], "Postsynaptic_ID": all_ids[1:],
                "Connectivity": np.array([2]), "Excitatory": np.array([1]),
                "Excitatory x Connectivity": np.array([2])}
        validate_index_mapping(data, all_ids)
        bad = dict(data, Presynaptic_Index=np.array([1]))
        with self.assertRaises(ValueError):
            validate_index_mapping(bad, all_ids)
        bad = dict(data)
        bad["Excitatory x Connectivity"] = np.array([-2])
        with self.assertRaises(ValueError):
            validate_index_mapping(bad, all_ids)

    def test_zero_sign_is_anatomical_edge_not_deleted(self):
        graph = fixture()
        graph.sign[-1] = 0
        graph.validate()
        circuit = RateCircuit(graph)
        self.assertEqual(len(graph.pre), 6)
        self.assertEqual(circuit.base._nnz(), 6)
        self.assertEqual(int(graph.signed[-1]), 0)

    def test_rewire_preserves_directed_degrees_and_sign_class_strata(self):
        n = 16
        pre = np.repeat(np.arange(n), 2)
        post = (pre + np.tile([1, 3], n)) % n
        graph = Graph(np.arange(n, dtype=np.int64), np.array(["Kenyon_Cell"] * n),
                      pre, post, np.ones(len(pre), dtype=np.int64),
                      np.ones(len(pre), dtype=np.int64), np.arange(len(pre)), {})
        rewired = degree_preserving_rewire(graph, 42)
        np.testing.assert_array_equal(np.bincount(graph.pre), np.bincount(rewired.pre))
        np.testing.assert_array_equal(np.bincount(graph.post), np.bincount(rewired.post))
        np.testing.assert_array_equal(graph.count, rewired.count)
        np.testing.assert_array_equal(graph.sign, rewired.sign)
        self.assertNotEqual(graph.digest(), rewired.digest())
        graph.validate()
        rewired.validate()

    def test_heldout_has_fixed_prototypes_and_independent_noise(self):
        a, y, _ = make_stimuli(42, 16, 32, 40, split="train")
        b, z, _ = make_stimuli(42, 16, 32, 40, split="heldout")
        again, _, _ = make_stimuli(42, 16, 32, 40, split="train")
        self.assertTrue(torch.equal(a, again))
        self.assertFalse(torch.equal(a, b))
        self.assertEqual(int(y.sum()), int(z.sum()))
        self.assertEqual(int(torch.count_nonzero(a[8:])), 0)

    def test_workload_hash_binds_mode_checkpoint_and_cpu_partitions(self):
        w = {"mode": "inference", "graphHash": "a" * 64, "modelHash": "b" * 64,
             "checkpointHash": "c" * 64, "parentCheckpointHash": None,
             "dtype": "float32", "layout": "coo", "batch": 4, "unrollSteps": 32}
        reference = [1, "inference", "small-circuit", "a" * 64, "b" * 64, "c" * 64,
                     None, "float32", "coo", 4, 32, "[]"]
        self.assertEqual(workload_hash(w), hashlib.sha256(json.dumps(reference, separators=(",", ":")).encode()).hexdigest())
        self.assertNotEqual(workload_hash(w), workload_hash(dict(w, mode="bptt")))
        self.assertNotEqual(workload_hash(w), workload_hash(dict(w, checkpointHash="d" * 64)))
        self.assertNotEqual(workload_hash(w), workload_hash(dict(w, declaredCpuFallbackOps=["one-op"])))


if __name__ == "__main__":
    unittest.main()
