# M4 local connectome experiment

The independent Python CLI in `neural/run_experiment.py` executes a small, real FlyWire-derived circuit on CUDA. It is an original **research rate-dynamics implementation**, not a reproduction of Shiu's LIF simulation, a complete fly, a language model, or evidence of subjective affect. It does not implement the online `NeuralAdapter` or activate artifacts in `MemoryStore`. Scope, permission, reset and output-delivery fences remain mandatory for any later integration.

**Current acceptance checkpoint:** final run `20261025T164817Z-d3d04a6f` exited 0 with `PASS_FOUR_MODES_AND_BOUNDED_CONTROLS`. CPU tests 8/8 and independent read-only review pass. The first run (`20261025T161608Z-347a9e2a`) remains `FAILED_OR_PARTIAL` because its reload check wrongly required identical CUDA output hashes. The corrected source preserves exact checkpoint-byte/state checks and uses declared FP32 logit tolerances, with separate output hashes/error reporting. One later attempt was `PRELAUNCH_REFUSED_NOT_STARTED` at the existing 1.5-GiB RAM gate. After a fresh normal-user reading showed 7.746 GiB available, the unchanged gated CLI completed all four modes and 24 conditions. Old evidence remains under its original source identity.

## Fixed sources and data handling

The coordinator downloads public research data once into the isolated local runtime. The CLI performs no network calls. It verifies three full SHA256 values and the exact 3,136-node numeric-ID selection before loading a batch of at most 131,072 edges.

- [Shiu source](https://github.com/philshiu/Drosophila_brain_model/tree/91bdd1e7dcf193f3e7ca5a8933497fcef63b7960): `Connectivity_783.parquet` and `Completeness_783.csv` at commit `91bdd1e7dcf193f3e7ca5a8933497fcef63b7960`. Code license is MIT; this implementation does not copy it.
- [FlyWire annotations](https://github.com/flyconnectome/flywire_annotations/blob/ebd66db2596fcc39c6950fb54ea3efa00f7fe8a0/supplemental_files/Supplemental_file1_neuron_annotations.tsv) at commit `ebd66db2596fcc39c6950fb54ea3efa00f7fe8a0`.
- FlyWire data are subject to [CC BY-NC 4.0 and FlyWire usage terms](https://join.flywire.ai/guidelines). This local research run does not redistribute the data or select a public project license. No EON GPL source is copied.

Selection: `side == left` and `cell_class` ALPN/Kenyon_Cell/MBON/DAN, plus MBIN with `hemibrain_type == APL`. The frozen counts are ALPN 341, KC 2,580, MBON 48, DAN 166 and APL 1. Numeric sorted IDs plus one final newline hash to `0a29fea2930e0ca9881d4bced69e085a74eeee664c6470c2f54371f87e694a83`. IDs remain int64 and never pass through JavaScript numbers or floating point.

Every source row is checked against the completeness table's index-to-root-ID mapping. The induced subgraph retains all original aggregate counts, signs and source row indices. Matrix orientation is `W[post, pre]`. The archive is a new derivative in the run directory; source files are never changed. Zero-sign anatomical edges are supported and retained.

An important source audit result is that this fixed parquet actually assigns PPL101 outgoing edges `Excitatory = +1`; the selected subgraph has no zero signed edges. The initial expectation that DAN edges would already be zero was wrong. The primary version retains the observed source assignment, including DAN fast propagation. This source convention is not proof of receptor physiology. A future DAN mask must be a separately identified model, never a silent alteration of this result.

## Explicit engineering choices

The recurrence is `h_next = (1-alpha)*h + alpha*clip(relu(g*W*h + input), 0, 10)`, with `alpha=0.25`, `g=0.90`, and fixed incoming absolute-row-sum normalization. The unit of time is a **dimensionless engineering step**, not milliseconds. These choices, normalization and any optimizer are included in the workload configuration hash.

Fixed propagation uses coalesced sparse COO. A sparse correction on the real KC→MBON edges implements bounded positive gains, preserving the source sign. BPTT differentiates through the unrolled recurrence and updates these actual circuit parameters as well as the readout. It does not count readout-only updates as BPTT of the circuit. PyTorch's [2.11 sparse matrix API](https://docs.pytorch.org/docs/2.11/generated/torch.sparse.mm.html) documents sparse-dense gradient support; actual success still requires this workload's native execution.

Local plasticity affects only real KC→MBON11 (`720575940623201833`, gamma1pedc) edges. A nonnegative KC eligibility trace multiplied by an explicit external PPL101 (`720575940621040737`) plasticity gate produces bounded depression. That extra gate is an engineered learning rule, not learning already present in the source connectivity. No-gate and no-odor controls must leave the gains unchanged. The APL identifier is `720575940624547622`.

The LTD-only rule is deliberately not given an invented recovery term: odor-only extinction cannot restore depressed weights, and reversal can only depress the second pattern. Those limitations are measured and retained rather than labeled successful biological extinction/reversal.

## Execution and evidence

Use the existing isolated runtime (Python 3.12.14, torch 2.11.0+cu128, numpy 2.5.4, pyarrow 26.0.0, psutil 7.2.2). No environment installation or modification is performed by the CLI.

```powershell
& 'C:\Users\saigy\AppData\Local\CompanionCoreLab\neural-20261025-v1\venv\Scripts\python.exe' -B -m unittest discover -s neural -p 'test_*.py' -v
& 'C:\Users\saigy\AppData\Local\CompanionCoreLab\neural-20261025-v1\venv\Scripts\python.exe' -B neural/run_experiment.py --data-dir 'C:\Users\saigy\AppData\Local\CompanionCoreLab\neural-20261025-v1\data\flywire-v783' --runs-dir 'C:\Users\saigy\AppData\Local\CompanionCoreLab\neural-20261025-v1\runs'
```

Every run creates a unique UTC/UUID directory outside OneDrive, including exact hash-verified copies of the three execution source files. A failed or partial run keeps `failure.json` and all earlier evidence. No old result, source data, checkpoint or environment is overwritten. Python bytecode creation is disabled.

Four separate exact resident-checkpoint operations are measured: inference, local plasticity, readout training, and BPTT. Each probe restores the same validated input checkpoint before each repeat; optimizer state begins empty for its explicitly defined one-minibatch operation. Eleven samples after one warmup include input transfer, complete operation, output transfer and CUDA synchronization. The separate preparation samples cover CPU-state-to-device restore, gradient reset, optimizer construction, parameter clones and synchronization. Disk checkpoint loading and synthetic stimulus generation are outside both timings and are not measured. Graph parsing/hash/index validation has its own preprocessing timing. These are resident-model measurements, not end-to-end cold process startup latency.

The workload hashes match the existing TypeScript array contract and bind mode, graph/configuration, implementation source, exact input checkpoint and parent, layout, dtype, batch and steps. A training output is a new checkpoint and cannot inherit its input's inference qualification. The runner reloads trained checkpoints and performs a separate inference probe. Reloaded weight tensors must match exactly; held-out logits must match at `rtol=2e-4, atol=2e-5`, with maximum error and both output hashes retained. Fixed seeds and requested deterministic algorithms do not imply bitwise-identical CUDA sparse reductions, even on the same device. Saved checkpoints contain model state and training metadata, not resumable optimizer state.

CUDA residency checks cover model tensors/buffers, inputs, outputs, gradients and Adam state. Timed CUDA events and explicit synchronization supplement tensor-device assertions. This is evidence about the authored worker, not a generic audit of hidden fallback in arbitrary third-party operators. Host parsing, orchestration and output handling remain CPU work and are stated separately. Host peak is the conservative process lifetime peak working set. Device evidence reports allocator allocated/reserved peaks and observed global device occupancy (which can include other applications); it does not reserve the GPU or establish a production memory guarantee.

## Bounded learning controls

The synthetic task presents four fixed ALPN activity patterns for the first quarter of a 32-step sequence, then asks for a binary identity label after the delay. Held-out trials use independent noise, with identical prototypes, splits and minibatches across each paired condition. These stimuli are synthetic rather than actual odor responses.

Three fixed seeds (101, 202, 303), batch 4 and 48 update opportunities are used for each readout/BPTT condition: real graph, rewired graph, no learning, and no circuit. The rewired control performs directed edge swaps within source/destination class and sign strata, preserving every node's unweighted in/out degree. It does not preserve weighted postsynaptic strength, spatial position or motifs. Counts remain tied to source edges. The no-circuit linear readout sees the full sequence's average input, so it is not denied the early stimulus.

All conditions receive the same examples and update cap. No-learning intentionally disables updates. Parameter counts and wall time are measured and reported; FLOPs are not measured. Parameter counts, FLOPs and wall time are not matched. A GRU comparator and richer behavioral protocols remain separate work. Three seeds and a small synthetic task cannot establish biological superiority. Accuracy without an advantage over controls remains a valid result.

The final machine-readable summary is the authority for what actually ran. Unit tests alone are synthetic CPU checks, and a generic GPU matrix smoke is not evidence for any of these four workloads. Research execution does not complete the entire M4 milestone or production readiness.

## Measured final result

The final summary SHA256 is `24f88a93412ecca195b4ec39786ca3d839f96e4ed121d6736dc522fa14249ef8`; model implementation identity is `152a501c135c31c0e9dd9760172b20440fc28f880ce1f1361b2e7f8447e2b4e0`. Full artifacts remain in the isolated local runtime's `runs/20261025T164817Z-d3d04a6f`. A small immutable summary copy and Python/TypeScript contract verification are in the sibling coordinator's `evidence/core-neural-native-20261025T164817Z-{summary,policy}.json`.

On RTX5070 Laptop/sm120, batch 4 and 32 engineering steps, the 11-sample resident-operation p95 values were inference 70.50 ms, local-plasticity 163.06 ms, readout-training 88.86 ms and BPTT 176.66 ms. The two representative trained-checkpoint inference probes measured 138.33/119.43 ms independently. These are distinct input/checkpoint workloads, not evidence that learning caused the timing differences. Maximum probe host lifetime peak was 2,059,112,448 B; observed device occupancy of 1,415,118,848 B can include other clients. The training allocator peak of 117,310,464 B is not total device memory demand.

| Condition | Readout accuracy, seeds 101/202/303 | BPTT accuracy, seeds 101/202/303 |
|---|---|---|
| Real graph | 1.00 / 0.75 / 0.50 | 1.00 / 0.75 / 0.50 |
| Rewired graph | 0.50 / 0.50 / 0.50 | 0.50 / 0.50 / 0.50 |
| No learning | 0.50 / 0.50 / 0.50 | 0.50 / 0.50 / 0.50 |
| No circuit | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |

Real mean accuracy was 0.75 with sample standard deviation 0.25. No-circuit mean loss of 0.002053 was below real readout 0.563784 and real BPTT 0.536308. The no-circuit algorithm is the same linear baseline in both mode groups, not two independent circuit-training methods. These results do not establish biological superiority or an accuracy improvement from BPTT.

There are 24,654 trainable real KC→MBON gains plus 98 head parameters; all three real BPTT runs changed circuit parameters (maximum theta deltas 1.18669/1.29210/1.40026). This is not a count of individually changed edges. Readout-only theta and all no-learning states stayed unchanged. All 24 reloaded states were exact; maximum logit difference was 2.38419e-7 within the declared rtol 2e-4 / atol 2e-5. The independent reviewer checked 102 artifact hashes, 48 checkpoint files and all eight aggregate rows without executing training again.

Six exact probes passed the TypeScript workload hash and policy contract at their evidence timestamps. Synthetic authority checks rejected changed checkpoints, expired probes, invalid lineage and withdrawn learning permission. This does not renew expiry or implement online authorization. Physical NPU was absent on the tested 9955HX host; no NPU execution/training is claimed. The next experiment needs stronger sequence tasks, a GRU comparator and biologically constrained recovery/extinction rules before any claim of more natural affect.
