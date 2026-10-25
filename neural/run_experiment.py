"""Explicit local research CLI. No host adapter, service, cloud calls or activation."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import traceback
import uuid

sys.dont_write_bytecode = True
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import numpy as np
import psutil
import torch

from circuit import DEFAULT_CONFIG, NoCircuit, RateCircuit, make_stimuli
from connectome import MBON11, Graph, canonical, degree_preserving_rewire, load_graph, object_hash, sha_file

MODES = ("inference", "local-plasticity", "readout-training", "bptt")


def write_json(path: Path, value) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def log(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False, allow_nan=False), flush=True)


def source_identity() -> dict:
    here = Path(__file__).parent
    files = {name: sha_file(here / name) for name in ("connectome.py", "circuit.py", "run_experiment.py")}
    return {"files": files, "sha256": object_hash(files)}


def snapshot_sources(output: Path, source: dict) -> None:
    destination = output / "source"
    destination.mkdir()
    for name, expected in source["files"].items():
        payload = (Path(__file__).parent / name).read_bytes()
        if hashlib.sha256(payload).hexdigest() != expected:
            raise RuntimeError("execution source changed before snapshot")
        with (destination / name).open("xb") as stream:
            stream.write(payload)
        if sha_file(destination / name) != expected:
            raise RuntimeError("execution source snapshot hash mismatch")


def tensor_hash(tensor: torch.Tensor) -> str:
    a = tensor.detach().cpu().contiguous().numpy()
    return hashlib.sha256(canonical([str(a.dtype), list(a.shape)]) + a.tobytes()).hexdigest()


def workload_hash(workload: dict) -> str:
    # Exact src/neural-policy.ts JSON-array contract (all numeric fields integers).
    ops = json.dumps(sorted(workload.get("declaredCpuFallbackOps", [])), separators=(",", ":"))
    fields = [1, workload["mode"], workload.get("circuit", "small-circuit"),
              workload["graphHash"], workload["modelHash"], workload["checkpointHash"],
              workload["parentCheckpointHash"], workload["dtype"], workload["layout"],
              workload["batch"], workload["unrollSteps"], ops]
    return hashlib.sha256(json.dumps(fields, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def runtime_identity() -> dict:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required for this explicit GPU experiment; no silent CPU fallback")
    exe = shutil.which("nvidia-smi")
    if not exe:
        raise RuntimeError("nvidia-smi required for stable physical identity and driver evidence")
    proc = subprocess.run([exe, "--query-gpu=index,uuid,name,driver_version,pci.bus_id",
                           "--format=csv,noheader,nounits"], capture_output=True, text=True,
                          check=True, timeout=15)
    devices = [[part.strip() for part in line.split(",")] for line in proc.stdout.strip().splitlines()]
    # This lab intentionally supports one visible physical GPU; ambiguous mapping fails closed.
    if len(devices) != 1 or torch.cuda.device_count() != 1 or os.environ.get("CUDA_VISIBLE_DEVICES") not in (None, "", "0"):
        raise RuntimeError("ambiguous CUDA-to-physical-device mapping")
    index, physical_uuid, name, driver, bus = devices[0]
    prop = torch.cuda.get_device_properties(0)
    if name != prop.name:
        raise RuntimeError("nvidia-smi and torch physical device names differ")
    device_id = "nvidia-uuid-sha256:" + hashlib.sha256(physical_uuid.encode()).hexdigest()
    identity = {"backend": "cuda", "deviceId": device_id,
                "deviceArchitecture": f"sm_{prop.major}{prop.minor}",
                "runtimeVersion": f"torch:{torch.__version__};python:{platform.python_version()}",
                "providerVersion": f"cuda:{torch.version.cuda};torch-build:{object_hash(torch.__config__.show())};cpu-threads:2;interop:1",
                "driverVersion": driver}
    return {"identity": identity, "actualDeviceId": device_id, "name": name,
            "physicalDeviceMapping": "single visible torch GPU matches single nvidia-smi UUID/name/index",
            "deviceTotalBytes": prop.total_memory, "platform": platform.platform(),
            "torchBuild": torch.__config__.show(), "npuStatus": "NOT_USED; separately enumerated absent by coordinator",
            "determinism": "fixed RNG seeds; deterministic algorithms requested; floating-point reductions can differ at tiny scale even on the same device; no bitwise guarantee"}


def cpu_state(model: torch.nn.Module) -> dict:
    return {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}


def save_checkpoint(path: Path, model: torch.nn.Module, graph: Graph, source: dict,
                    *, parent: str | None, metadata: dict) -> dict:
    payload = {"format": 1, "structuralSha256": graph.digest(), "modelSha256": source["sha256"],
               "parentCheckpointHash": parent, "state": cpu_state(model), "metadata": metadata}
    with path.open("xb") as stream:
        torch.save(payload, stream)
    return {"path": str(path), "sha256": sha_file(path), "parentCheckpointHash": parent,
            "structuralSha256": graph.digest(), "modelSha256": source["sha256"]}


def load_checkpoint(record: dict, model: torch.nn.Module, graph: Graph, source: dict) -> dict:
    path = Path(record["path"])
    if sha_file(path) != record["sha256"]:
        raise ValueError("checkpoint bytes changed")
    data = torch.load(path, map_location="cpu", weights_only=True)
    if data["format"] != 1 or data["structuralSha256"] != graph.digest() or data["modelSha256"] != source["sha256"]:
        raise ValueError("checkpoint graph/source identity mismatch")
    if data["parentCheckpointHash"] != record["parentCheckpointHash"]:
        raise ValueError("checkpoint parent mismatch")
    model.load_state_dict(data["state"], strict=True)
    return data


def optimizer_for(model: torch.nn.Module):
    return torch.optim.Adam([p for p in model.parameters() if p.requires_grad],
                            lr=0.03, betas=(0.9, 0.999), eps=1e-8, capturable=True,
                            foreach=False, fused=False)


def assert_cuda(model, *tensors, optimizer=None) -> None:
    checked = list(model.parameters()) + list(model.buffers()) + list(tensors)
    checked += [p.grad for p in model.parameters() if p.grad is not None]
    if optimizer is not None:
        for state in optimizer.state.values():
            checked += [value for value in state.values() if isinstance(value, torch.Tensor)]
    if any(t.device.type != "cuda" or t.device.index != 0 for t in checked):
        raise AssertionError("neural tensor/gradient/optimizer state left the selected CUDA device")


def train_step(model, x, y, mode: str, optimizer):
    optimizer.zero_grad(set_to_none=True)
    logits = model.readout(model.frozen_features(x)) if mode == "readout-training" and isinstance(model, RateCircuit) else model(x)
    loss = torch.nn.functional.cross_entropy(logits, y)
    loss.backward()
    if not torch.isfinite(loss):
        raise FloatingPointError("nonfinite training loss")
    grads = [p.grad for p in model.parameters() if p.requires_grad and p.grad is not None]
    if not grads or not all(bool(torch.isfinite(g).all().item()) for g in grads):
        raise FloatingPointError("missing or nonfinite gradient")
    torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 5.0)
    optimizer.step()
    assert_cuda(model, x, y, logits, optimizer=optimizer)
    return logits, loss


def probe(mode: str, model: RateCircuit, graph: Graph, checkpoint: dict, source: dict,
          runtime: dict, x_cpu: torch.Tensor, y_cpu: torch.Tensor, output: Path) -> dict:
    """Qualify one resident-checkpoint batch operation, restoring its input each repeat."""
    directory = output
    directory.mkdir()
    initial = load_checkpoint(checkpoint, model, graph, source)["state"]
    operation = {"mode": mode, "dynamics": DEFAULT_CONFIG, "structuralSha256": graph.digest(),
                 "inputSha256": tensor_hash(x_cpu), "labelsSha256": tensor_hash(y_cpu),
                 "operation": "one resident-checkpoint batch; input transfer, full operation, output transfer and CUDA synchronization",
                 "optimizer": None if mode in ("inference", "local-plasticity") else
                    {"name": "Adam", "lr": 0.03, "betas": [0.9, 0.999], "eps": 1e-8,
                     "capturable": True, "foreach": False, "fused": False, "initialState": "empty", "clipGradNorm": 5.0},
                 "ppl101Gate": 1.0 if mode == "local-plasticity" else None,
                 "checkpointPreparation": "separately timed CPU-state-to-device restore, gradient reset, optimizer construction, parameter clones and synchronization; excludes disk checkpoint load and stimulus generation",
                 "cpuPartitions": "host orchestration, prepared synthetic input and output metrics; no deliberate CPU neural partition"}
    workload = {"mode": mode, "circuit": "small-circuit", "graphHash": object_hash(operation),
                "modelHash": source["sha256"], "checkpointHash": checkpoint["sha256"],
                "parentCheckpointHash": checkpoint["parentCheckpointHash"], "dtype": "float32",
                "layout": "fixed-coalesced-COO-plus-index-add-real-edge-deltas",
                "batch": x_cpu.shape[1], "unrollSteps": x_cpu.shape[0], "declaredCpuFallbackOps": []}
    durations, kernel_durations, preparation = [], [], []
    validation = []
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()
    free, total = torch.cuda.mem_get_info()
    baseline_reserved = torch.cuda.memory_reserved()
    baseline_nonallocator_used = max(0, total - free - baseline_reserved)
    peak_global_used = total - free
    for repetition in range(12):
        t0 = time.perf_counter()
        model.load_state_dict(initial, strict=True)
        model.zero_grad(set_to_none=True)
        opt = optimizer_for(model) if mode in ("readout-training", "bptt") else None
        before = {name: param.detach().clone() for name, param in model.named_parameters()}
        gain_before = model.local_gain.clone()
        torch.cuda.synchronize()
        preparation.append((time.perf_counter() - t0) * 1000)
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        t0 = time.perf_counter()
        start.record()
        x, y = x_cpu.to("cuda"), y_cpu.to("cuda")
        details = {}
        if mode == "local-plasticity":
            details = model.local_pair(x, 1.0)
            with torch.no_grad():
                logits = model(x)
        elif opt is not None:
            logits, loss = train_step(model, x, y, mode, opt)
            details["loss"] = float(loss.detach().cpu())
        else:
            with torch.no_grad():
                logits = model(x)
        assert_cuda(model, x, y, logits, optimizer=opt)
        host_output = logits.detach().cpu()
        end.record()
        torch.cuda.synchronize()
        elapsed = (time.perf_counter() - t0) * 1000
        if not bool(torch.isfinite(host_output).all()):
            raise FloatingPointError("nonfinite probe output")
        deltas = {name: float((param.detach() - before[name]).abs().max().item())
                  for name, param in model.named_parameters()}
        details["parameterMaxDeltas"] = deltas
        if mode == "local-plasticity" and not bool((model.local_gain < gain_before).any()):
            raise AssertionError("local plasticity did not update any real edge")
        if mode in ("readout-training", "bptt") and not any(delta > 0 for delta in deltas.values()):
            raise AssertionError("optimizer produced no parameter update")
        if mode == "bptt" and (deltas["theta"] <= 0 or model.theta.grad is None or not bool((model.theta.grad != 0).any())):
            raise AssertionError("BPTT failed to differentiate and update real circuit edges")
        details["outputSha256"] = tensor_hash(host_output)
        validation.append(details)
        free_now, _ = torch.cuda.mem_get_info()
        peak_global_used = max(peak_global_used, total - free_now)
        if repetition:
            durations.append(elapsed)
            kernel_durations.append(start.elapsed_time(end))
    # This output exists only as proof of the qualified operation; it is not activated.
    child = save_checkpoint(directory / "operation-output.pt", model, graph, source,
                            parent=checkpoint["sha256"], metadata={"probeMode": mode, "operation": operation})
    now = int(time.time() * 1000)
    memory = psutil.Process().memory_info()
    reserved = torch.cuda.max_memory_reserved()
    peak_device = max(peak_global_used, baseline_nonallocator_used + reserved)
    p = {"identity": runtime["identity"], "workloadHash": workload_hash(workload),
         "checkedAtMs": now, "expiresAtMs": now + 60 * 60 * 1000,
         "forward": "passed", "residency": "passed", "benchmark": "passed",
         "update": "not-run" if mode == "inference" else "passed",
         "backward": "passed" if mode in ("readout-training", "bptt") else "not-run",
         "actualDeviceId": runtime["actualDeviceId"], "cpuFallbackOps": [],
         "peakHostBytes": max(memory.rss, getattr(memory, "peak_wset", memory.rss)),
         "peakDeviceBytes": peak_device,
         "p95Ms": float(np.percentile(durations, 95))}
    result = {"status": "PASS_EXACT_RESIDENT_CHECKPOINT_OPERATION", "workload": workload, "probe": p,
              "operation": operation, "inputCheckpoint": checkpoint, "outputCheckpoint": child,
              "samplesMs": durations, "cudaEventSamplesMs": kernel_durations,
              "checkpointPreparationSamplesMs": preparation,
              "peakTorchAllocatedBytes": torch.cuda.max_memory_allocated(),
              "peakTorchReservedBytes": reserved, "observedGlobalUsedDeviceBytes": peak_global_used,
              "memoryMethod": "process lifetime peak working set; CUDA allocator peak plus baseline nonallocator occupancy, bounded by observed global occupancy; includes other GPU clients; not an exclusive reservation",
              "residencyEvidence": "authored neural tensors, buffers, inputs, outputs, gradients and Adam states asserted cuda:0; positive synchronized CUDA event durations; no CPU neural partition in source; not a general third-party operator fallback audit",
              "validation": validation, "modelSource": source,
              "notAccepted": ["online NeuralAdapter", "MemoryStore artifact activation", "other checkpoint inference", "production authorization"]}
    write_json(directory / "probe.json", result)
    log("probe", mode=mode, p95Ms=p["p95Ms"], peakHostBytes=p["peakHostBytes"],
        peakDeviceBytes=peak_device, circuitDelta=validation[-1]["parameterMaxDeltas"]["theta"])
    model.load_state_dict(initial, strict=True)
    return result


@torch.no_grad()
def evaluate(model, x_cpu, y_cpu, batch: int = 4) -> tuple[dict, torch.Tensor]:
    logits = []
    for first in range(0, len(y_cpu), batch):
        x = x_cpu[:, first:first + batch].to("cuda")
        value = model(x)
        assert_cuda(model, x, value)
        logits.append(value.cpu())
    all_logits = torch.cat(logits)
    loss = float(torch.nn.functional.cross_entropy(all_logits, y_cpu))
    accuracy = float((all_logits.argmax(dim=1) == y_cpu).float().mean())
    if not np.isfinite(loss):
        raise FloatingPointError("nonfinite heldout result")
    return {"loss": loss, "accuracy": accuracy, "outputSha256": tensor_hash(all_logits)}, all_logits


def parity(graph, source, output, steps: int):
    torch.manual_seed(7)
    cpu = RateCircuit(graph).cpu()
    gpu = copy.deepcopy(cpu).cuda()
    x, _, _ = make_stimuli(101, 4, steps, len(cpu.alpn), split="heldout")
    with torch.no_grad():
        start = time.perf_counter()
        h_cpu, logits_cpu = cpu.rollout(x), cpu(x)
        cpu_ms = (time.perf_counter() - start) * 1000
        h_gpu, logits_gpu = gpu.rollout(x.cuda()).cpu(), gpu(x.cuda()).cpu()
    torch.testing.assert_close(h_gpu, h_cpu, rtol=2e-4, atol=2e-5)
    torch.testing.assert_close(logits_gpu, logits_cpu, rtol=2e-4, atol=2e-5)
    result = {"status": "PASS", "stateMaxAbsError": float((h_cpu - h_gpu).abs().max()),
              "logitMaxAbsError": float((logits_cpu - logits_gpu).abs().max()),
              "rtol": 2e-4, "atol": 2e-5, "cpuTwoRolloutsMs": cpu_ms,
              "nodes": graph.n, "edges": len(graph.pre), "batch": 4, "unrollSteps": steps,
              "structuralSha256": graph.digest(), "modelSource": source}
    write_json(output / "cpu-gpu-parity.json", result)
    log("parity", **{k: v for k, v in result.items() if k != "modelSource"})
    return result


def local_assay(graph, source, output, steps: int) -> dict:
    directory = output / "local-assay"
    directory.mkdir()
    torch.manual_seed(101)
    model = RateCircuit(graph).cuda()
    initial = cpu_state(model)
    x, _, _ = make_stimuli(101, 4, steps, len(model.alpn), split="train")
    odors = [x[:, i:i + 1].cuda() for i in range(2)]
    target = int(np.flatnonzero(graph.ids == MBON11)[0])

    @torch.no_grad()
    def responses():
        return [float(model.rollout(odor)[target].mean().cpu()) for odor in odors]

    base = responses()
    model.local_pair(odors[0], 0.0)
    no_gate_delta = float((model.local_gain - initial["local_gain"].cuda()).abs().max().item())
    model.load_state_dict(initial)
    model.local_pair(torch.zeros_like(odors[0]), 1.0)
    no_odor_delta = float((model.local_gain - initial["local_gain"].cuda()).abs().max().item())
    if no_gate_delta != 0 or no_odor_delta != 0:
        raise AssertionError("no-gate/no-odor controls updated plastic weights")
    model.load_state_dict(initial)
    input_checkpoint = save_checkpoint(directory / "input.pt", model, graph, source, parent=None, metadata={"assay": "local LTD"})
    conditioning = [model.local_pair(odors[0], 1.0) for _ in range(4)]
    conditioned = responses()
    conditioned_gain = model.local_gain.clone()
    extinction = [model.local_pair(odors[0], 0.0) for _ in range(4)]
    extinguished = responses()
    extinction_gain_delta = float((conditioned_gain - model.local_gain).abs().max().item())
    reversal = [model.local_pair(odors[1], 1.0) for _ in range(4)]
    reversed_response = responses()
    if not all(r["onlyMbon11Changed"] and r["finite"] for r in conditioning + extinction + reversal):
        raise AssertionError("local rule violated anatomical target or finite dynamics")
    checkpoint = save_checkpoint(directory / "output.pt", model, graph, source, parent=input_checkpoint["sha256"],
                                 metadata={"conditioningTrials": 4, "extinctionTrials": 4, "reversalTrials": 4})
    result = {"status": "PASS_RULE_AND_NEGATIVE_CONTROLS", "inputCheckpoint": input_checkpoint,
              "outputCheckpoint": checkpoint, "noGateMaxWeightDelta": no_gate_delta,
              "noOdorMaxWeightDelta": no_odor_delta, "baselineResponses": base,
              "conditionedResponses": conditioned, "extinctionResponses": extinguished,
              "reversalResponses": reversed_response, "conditioning": conditioning,
              "extinction": extinction, "reversal": reversal, "extinctionMaxWeightDelta": extinction_gain_delta,
              "interpretation": "LTD-only rule cannot recover depressed weights during odor-only extinction. Reversal only depresses the second pattern; no claim of successful biological extinction/reversal.",
              "gate": "external scalar assigned to PPL101 plasticity channel, separate from unmodified source fast connectivity",
              "timeUnit": "dimensionless engineering steps"}
    write_json(directory / "result.json", result)
    log("local-assay", baseline=base, conditioned=conditioned, extinction=extinguished,
        reversal=reversed_response, noGate=no_gate_delta, noOdor=no_odor_delta)
    return result


def train_condition(graph, condition, mode, seed, source, output, runtime, *, steps, updates, qualify):
    directory = output / f"seed-{seed}" / mode / condition
    directory.mkdir(parents=True)
    torch.manual_seed(seed)
    if condition == "no-circuit":
        model = NoCircuit(int(np.count_nonzero(graph.classes == "ALPN"))).cuda()
    else:
        model = RateCircuit(graph, train_edges=mode == "bptt" and condition != "no-learning").cuda()
    train_x, train_y, train_meta = make_stimuli(seed, 64, steps, int(np.count_nonzero(graph.classes == "ALPN")), split="train")
    test_x, test_y, test_meta = make_stimuli(seed, 64, steps, train_x.shape[2], split="heldout")
    dataset = {"train": train_meta, "heldout": test_meta, "trainInputSha256": tensor_hash(train_x),
               "trainLabelsSha256": tensor_hash(train_y), "heldoutInputSha256": tensor_hash(test_x),
               "heldoutLabelsSha256": tensor_hash(test_y)}
    input_checkpoint = save_checkpoint(directory / "input.pt", model, graph, source, parent=None,
                                      metadata={"mode": mode, "condition": condition, "seed": seed, "dataset": dataset})
    if qualify:
        probe(mode, model, graph, input_checkpoint, source, runtime, train_x[:, :4], train_y[:4], directory / "operation-probe")
    before, _ = evaluate(model, test_x, test_y)
    start_state = cpu_state(model)
    opt = optimizer_for(model) if condition != "no-learning" else None
    generator = torch.Generator().manual_seed(seed + 900003)
    order = torch.randperm(64, generator=generator)
    losses = []
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    started = time.perf_counter()
    for step in range(updates):
        if step % 16 == 0 and step:
            order = torch.randperm(64, generator=generator)
        idx = order[(step % 16) * 4:(step % 16 + 1) * 4]
        x, y = train_x[:, idx].cuda(), train_y[idx].cuda()
        if opt is None:
            with torch.no_grad():
                logits = model(x)
                loss = torch.nn.functional.cross_entropy(logits, y)
            assert_cuda(model, x, y, logits)
        else:
            logits, loss = train_step(model, x, y, mode, opt)
        losses.append(float(loss.detach().cpu()))
    torch.cuda.synchronize()
    train_seconds = time.perf_counter() - started
    training_peak_allocated = torch.cuda.max_memory_allocated()
    training_peak_reserved = torch.cuda.max_memory_reserved()
    after, after_logits = evaluate(model, test_x, test_y)
    final_state = cpu_state(model)
    changes = {name: float((final_state[name] - value).abs().max()) for name, value in start_state.items()}
    if condition == "no-learning" and any(changes.values()):
        raise AssertionError("no-learning control changed parameters")
    if condition != "no-learning" and not any(changes.values()):
        raise AssertionError("training produced no parameter update")
    if mode == "bptt" and condition in ("real", "rewired") and changes.get("theta", 0) <= 0:
        raise AssertionError("BPTT did not change real-edge parameters")
    output_checkpoint = save_checkpoint(directory / "output.pt", model, graph, source,
                        parent=input_checkpoint["sha256"], metadata={"mode": mode, "condition": condition,
                        "seed": seed, "dataset": dataset, "updates": updates if opt else 0,
                        "optimizer": "Adam lr0.03 betas0.9/0.999 eps1e-8 capturable; clip norm5", "losses": losses})
    if qualify:
        # New bytes have their own inference workload; the old training probe is not reused.
        probe("inference", model, graph, output_checkpoint, source, runtime,
              test_x[:, :4], test_y[:4], directory / "reloaded-output-inference-probe")
    # Verify safe reload independently of a probe's temporary state changes.
    loaded = load_checkpoint(output_checkpoint, model, graph, source)
    weights_exact = all(torch.equal(value, model.state_dict()[name].detach().cpu())
                        for name, value in loaded["state"].items())
    if not weights_exact:
        raise AssertionError("checkpoint tensor bytes did not reload exactly")
    reloaded, reloaded_logits = evaluate(model, test_x, test_y)
    # CUDA sparse reductions need not be bitwise repeatable. Preserve both hashes
    # and require independently chosen FP32 numerical parity, as for CPU/GPU.
    torch.testing.assert_close(reloaded_logits, after_logits, rtol=2e-4, atol=2e-5)
    reload_validation = {"weightsExact": weights_exact,
                         "maxLogitAbsError": float((reloaded_logits - after_logits).abs().max()),
                         "rtol": 2e-4, "atol": 2e-5,
                         "outputHashesEqual": reloaded["outputSha256"] == after["outputSha256"]}
    result = {"status": "PASS_EXECUTION_NOT_BIOLOGICAL_ADVANTAGE", "mode": mode, "condition": condition,
              "seed": seed, "dataset": dataset, "before": before, "after": after, "reloaded": reloaded,
              "reloadValidation": reload_validation,
              "trainLosses": losses, "trainSeconds": train_seconds,
              "parameterCount": sum(p.numel() for p in model.parameters()),
              "trainableParameterCount": sum(p.numel() for p in model.parameters() if p.requires_grad) if opt else 0,
              "realCircuitTrainableEdges": int(model.theta.numel()) if isinstance(model, RateCircuit) and model.theta.requires_grad else 0,
              "parameterMaxDeltas": changes, "inputCheckpoint": input_checkpoint, "outputCheckpoint": output_checkpoint,
              "peakTorchAllocatedBytes": training_peak_allocated,
              "peakTorchReservedBytes": training_peak_reserved,
              "matchedBudget": {"batch": 4, "sequenceSteps": steps, "presentations": updates * 4,
                                "optimizerSteps": updates if opt else 0, "updateCap": updates,
                                "caveat": "identical data, minibatches and update cap; no-learning disables updates; parameter counts/FLOPs/wall time are not matched"}}
    write_json(directory / "result.json", result)
    log("trained", seed=seed, mode=mode, condition=condition, before=before["accuracy"],
        after=after["accuracy"], loss=after["loss"], seconds=train_seconds,
        circuitDelta=changes.get("theta", 0))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--runs-dir", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--updates", type=int, default=48)
    parser.add_argument("--seeds", type=int, nargs="+", default=[101, 202, 303])
    args = parser.parse_args()
    if args.steps < 4 or args.steps > 64 or args.updates < 1 or args.updates > 128 or len(set(args.seeds)) != len(args.seeds) or len(args.seeds) < 3:
        parser.error("bounded lab requires 4..64 steps, 1..128 updates and at least 3 distinct seeds")
    repo = Path(__file__).resolve().parents[1]
    runs = args.runs_dir.resolve()
    if runs == repo or repo in runs.parents or "onedrive" in str(runs).lower():
        parser.error("runtime artifacts must be outside the source tree and OneDrive")
    if psutil.virtual_memory().available < 1536 * 1024**2:
        raise RuntimeError("less than 1.5 GiB host memory available; experiment not started")
    runs.mkdir(parents=True, exist_ok=True)
    output = runs / (dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    output.mkdir(exist_ok=False)
    log("run-start", directory=str(output))
    try:
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        torch.use_deterministic_algorithms(True)
        torch.backends.cuda.matmul.allow_tf32 = False
        runtime = runtime_identity()
        if torch.cuda.mem_get_info()[0] < 768 * 1024**2:
            raise RuntimeError("less than 768 MiB CUDA free memory; workload not started")
        source = source_identity()
        write_json(output / "runtime.json", runtime)
        write_json(output / "model-source.json", source)
        snapshot_sources(output, source)
        started = time.perf_counter()
        graph = load_graph(args.data_dir.resolve())
        preprocessing = time.perf_counter() - started
        graph.save(output / "subgraph-source.npz")
        manifest = {**graph.metadata, "archiveSha256": sha_file(output / "subgraph-source.npz"),
                    "preprocessingSeconds": preprocessing, "batch": 4, "unrollSteps": args.steps,
                    "seeds": args.seeds, "updates": args.updates, "config": DEFAULT_CONFIG,
                    "implementationClaim": "original research rate dynamics on a fixed real connectome subgraph; not Shiu LIF reproduction or a human affect model"}
        write_json(output / "graph-manifest.json", manifest)
        log("graph", nodes=graph.n, edges=len(graph.pre), zeroSigned=graph.metadata["zeroSignedEdges"],
            sourceHash=graph.digest(), preprocessingSeconds=preprocessing)
        parity_result = parity(graph, source, output, args.steps)
        local_result = local_assay(graph, source, output, args.steps)
        torch.manual_seed(101)
        model = RateCircuit(graph).cuda()
        initial = save_checkpoint(output / "initial.pt", model, graph, source, parent=None, metadata={"seed": 101})
        x, y, _ = make_stimuli(101, 4, args.steps, len(model.alpn), split="train")
        base_probes = [probe(mode, model, graph, initial, source, runtime, x, y, output / f"{mode}-probe")
                       for mode in ("inference", "local-plasticity")]
        del model
        training = []
        for seed in args.seeds:
            rewired = degree_preserving_rewire(graph, seed + 700003)
            rewired.save(output / f"rewired-{seed}.npz")
            write_json(output / f"rewired-{seed}.json", rewired.metadata)
            for mode in ("readout-training", "bptt"):
                for condition in ("real", "rewired", "no-learning", "no-circuit"):
                    training.append(train_condition(rewired if condition == "rewired" else graph,
                                    condition, mode, seed, source, output, runtime,
                                    steps=args.steps, updates=args.updates, qualify=seed == args.seeds[0] and condition == "real"))
        aggregates = {}
        for mode in ("readout-training", "bptt"):
            aggregates[mode] = {}
            for condition in ("real", "rewired", "no-learning", "no-circuit"):
                rows = [r for r in training if r["mode"] == mode and r["condition"] == condition]
                values = [r["after"]["accuracy"] for r in rows]
                aggregates[mode][condition] = {"accuracies": values, "meanAccuracy": float(np.mean(values)),
                    "sampleStdAccuracy": float(np.std(values, ddof=1)),
                    "meanLoss": float(np.mean([r["after"]["loss"] for r in rows])),
                    "totalTrainSeconds": sum(r["trainSeconds"] for r in rows)}
        inventory = {str(path.relative_to(output)): sha_file(path) for path in output.rglob("*") if path.is_file()}
        summary = {"status": "PASS_FOUR_MODES_AND_BOUNDED_CONTROLS", "runDirectory": str(output),
                   "runtime": runtime, "modelSource": source, "manifest": manifest,
                   "parity": parity_result, "localAssay": local_result, "aggregates": aggregates,
                   "trainingRuns": len(training), "artifactsSha256": inventory,
                   "limitations": ["synthetic delayed identity task; not real behavior or affect",
                                   "three seeds do not establish biological superiority",
                                   "LTD-only extinction/reversal lacks recovery",
                                   "GRU baseline and richer reversal tasks NOT_RUN",
                                   "no online adapter, scope binding, artifact activation or production integration",
                                   "source signs including DAN +1 retained; not measured receptor physiology",
                                   "probe validity bound to exact input checkpoint; output inference separately tested"]}
        write_json(output / "summary.json", summary)
        log("run-complete", directory=str(output), status=summary["status"], aggregates=aggregates)
    except BaseException as error:
        write_json(output / "failure.json", {"status": "FAILED_OR_PARTIAL", "type": type(error).__name__,
                   "message": str(error), "traceback": traceback.format_exc(), "source": source_identity()})
        log("run-failed", directory=str(output), error=str(error))
        raise


if __name__ == "__main__":
    main()
