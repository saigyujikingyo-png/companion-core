"""Independent new-process reload/evaluation. No backward/optimizer/update path."""
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import traceback


def fail():
    raise RuntimeError("TJ1_EVALUATOR_REFUSED")


def read(path, expected):
    p = Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_size > 1048576:
        fail()
    raw = p.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        fail()
    return raw


def memory():
    if os.name == "nt":
        class Mem(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in
                ("total", "available", "page_total", "page_available", "virtual_total", "virtual_available", "extended")]
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("faults", ctypes.c_ulong)] + [(n, ctypes.c_size_t) for n in
                ("peak", "current", "qpp", "qp", "qpnp", "qnp", "page", "peak_page")]
        m, c = Mem(), Counters()
        m.length, c.cb = ctypes.sizeof(m), ctypes.sizeof(c)
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        get = ctypes.windll.psapi.GetProcessMemoryInfo
        get.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        if not kernel.GlobalMemoryStatusEx(ctypes.byref(m)) or not get(kernel.GetCurrentProcess(), ctypes.byref(c), c.cb):
            fail()
        return int(c.peak), int(m.available)
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == "darwin" else peak * 1024), int(os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))


def bits(value):
    if not math.isfinite(float(value)):
        fail()
    return struct.pack(">d", float(value)).hex()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def main():
    if len(sys.argv) != 2:
        fail()
    raw = Path(sys.argv[1]).read_bytes()
    if len(raw) > 8192:
        fail()
    r = json.loads(raw)
    required = {"version", "launchId", "manifestDigest", "scriptDigest", "evalPath", "evalDigest", "initialPath", "initialDigest",
                "weightsPath", "weightsDigest", "checkpointPath", "checkpointDigest", "configDigest", "trainDigest", "trainerDigest"}
    if set(r) != required or r["version"] != 1 or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != r["scriptDigest"]:
        fail()
    initial = json.loads(read(r["initialPath"], r["initialDigest"]))
    export = json.loads(read(r["weightsPath"], r["weightsDigest"]))
    evaluation = [json.loads(line) for line in read(r["evalPath"], r["evalDigest"]).splitlines()]
    read(r["checkpointPath"], r["checkpointDigest"])
    if len(evaluation) != 128 or set(export) != {"format", "tensors"} or export["format"] != "tj1-weights-v1":
        fail()
    import torch
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    decode = lambda h: struct.unpack(">d", bytes.fromhex(h))[0]
    sequence = 0

    def emit(kind, data):
        nonlocal sequence
        sequence += 1
        frame = {"protocol": "TJ1_WORKER_V1", "stage": "evaluator", "launchId": r["launchId"], "manifestDigest": r["manifestDigest"],
                 "sequence": str(sequence), "kind": kind, "data": data}
        encoded = canonical(frame)
        if len(encoded) > 8192:
            fail()
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()

    rss, available = memory()
    if available < 1073741824 or rss > 1610612736:
        fail()
    emit("READY", {"runtime": "torch:" + torch.__version__, "rssBytes": str(rss), "availableBytes": str(available)})
    permit = sys.stdin.buffer.readline(8193)
    if len(permit) > 8192 or json.loads(permit) != {"command": "EVALUATE", "step": "0", "launchId": r["launchId"], "manifestDigest": r["manifestDigest"]}:
        fail()
    checkpoint = torch.load(r["checkpointPath"], map_location="cpu", weights_only=True)
    keys = {"format", "model", "optimizer", "torch_rng_state", "completed_steps", "data_position", "config", "config_digest", "train_digest", "initial_digest",
            "manifest_digest", "trainer_digest", "seed", "torch_version"}
    if set(checkpoint) != keys or checkpoint["format"] != "tj1-full-checkpoint-v1" or checkpoint["completed_steps"] != 64 or checkpoint["data_position"] != 0:
        fail()
    for field in ("config_digest", "train_digest", "initial_digest", "manifest_digest", "trainer_digest"):
        if checkpoint[field] != r[{"config_digest": "configDigest", "train_digest": "trainDigest", "initial_digest": "initialDigest", "manifest_digest": "manifestDigest", "trainer_digest": "trainerDigest"}[field]]:
            fail()
    if hashlib.sha256(canonical(checkpoint["config"])).hexdigest() != r["configDigest"] or checkpoint["seed"] != 103:
        fail()
    if not isinstance(checkpoint["torch_rng_state"], torch.Tensor) or checkpoint["torch_rng_state"].dtype != torch.uint8 or checkpoint["torch_rng_state"].numel() > 8192:
        fail()
    if set(checkpoint["model"]) != {"weight", "bias"} or set(checkpoint["optimizer"]) != {"state", "param_groups"}:
        fail()
    if set(checkpoint["optimizer"]["state"]) != {0, 1} or len(checkpoint["optimizer"]["param_groups"]) != 1:
        fail()
    params = checkpoint["optimizer"]["param_groups"][0]
    if params["lr"] != .1 or params["momentum"] != .5 or params["dampening"] != 0 or params["weight_decay"] != 0 or params["nesterov"] or params["params"] != [0, 1]:
        fail()
    tensors = export["tensors"]
    model = torch.nn.Linear(6, 2, bias=True, device="cpu", dtype=torch.float64)
    loaded = {}
    for index, (name, shape, count) in enumerate((("weight", (2, 6), 12), ("bias", (2,), 2))):
        t = tensors[name]
        if set(t) != {"dtype", "shape", "bits"} or t["dtype"] != "f64" or t["shape"] != list(shape) or len(t["bits"]) != count * 16:
            fail()
        values = [decode(t["bits"][i:i+16]) for i in range(0, count * 16, 16)]
        loaded[name] = torch.tensor(values, dtype=torch.float64, device="cpu").reshape(shape)
        native = checkpoint["model"][name]
        momentum = checkpoint["optimizer"]["state"][index]
        if set(momentum) != {"momentum_buffer"}:
            fail()
        for value in (native, momentum["momentum_buffer"]):
            if not isinstance(value, torch.Tensor) or tuple(value.shape) != shape or value.dtype != torch.float64 or value.device.type != "cpu" or not torch.isfinite(value).all():
                fail()
        if "".join(bits(v) for v in native.reshape(-1).tolist()) != t["bits"]:
            fail()
    model.load_state_dict(loaded, strict=True)
    model.eval()
    x = torch.tensor([[decode(h) for h in row["x"]] for row in evaluation], dtype=torch.float64, device="cpu")
    y = torch.tensor([[decode(h) for h in row["y"]] for row in evaluation], dtype=torch.float64, device="cpu")
    with torch.no_grad():
        predictions = model(x)
    weights = loaded["weight"].reshape(-1).tolist()
    bias = loaded["bias"].tolist()
    manual = []
    for row in evaluation:
        values = [decode(h) for h in row["x"]]
        for j in range(2):
            total = bias[j]
            for k in range(6):
                total += values[k] * weights[j * 6 + k]
            manual.append(total)
    if not all(math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12) for a, b in zip(predictions.reshape(-1).tolist(), manual)):
        fail()
    initial_values = [decode(initial["tensors"][name]["bits"][i:i+16]) for name, count in (("weight", 12), ("bias", 2)) for i in range(0, count * 16, 16)]
    if any(v != 0 for v in initial_values):
        fail()
    all_values = weights + bias
    mse = ((predictions-y)**2).mean().item()
    baseline = (y**2).mean().item()
    delta = math.sqrt(sum((a-b)**2 for a, b in zip(all_values, initial_values)))
    emit("RESULT", {"weightsDigest": r["weightsDigest"], "checkpointDigest": r["checkpointDigest"], "initialDigest": r["initialDigest"],
                    "tensors": tensors, "predictions": [bits(v) for v in predictions.reshape(-1).tolist()], "mseBits": bits(mse), "baselineBits": bits(baseline),
                    "deltaBits": bits(delta), "changed": str(sum(a != b for a, b in zip(all_values, initial_values))), "rssBytes": str(memory()[0]), "checkpointVerified": True})


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc(limit=16, file=sys.stderr)
        sys.exit(1)
