"""Pinned TJ1 CPU canary. No public command/model/data selection and no retry."""
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import traceback

MAX_FILE = 1048576


def fail():
    raise RuntimeError("TJ1_WORKER_REFUSED")


def read(path, expected):
    p = Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_size > MAX_FILE:
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


def tensor_record(weight, bias):
    return {"weight": {"dtype": "f64", "shape": [2, 6], "bits": "".join(bits(v) for v in weight.detach().reshape(-1).tolist())},
            "bias": {"dtype": "f64", "shape": [2], "bits": "".join(bits(v) for v in bias.detach().reshape(-1).tolist())}}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def main():
    if len(sys.argv) != 2:
        fail()
    request_raw = Path(sys.argv[1]).read_bytes()
    if len(request_raw) > 8192:
        fail()
    r = json.loads(request_raw)
    required = {"version", "launchId", "manifestDigest", "scriptDigest", "trainPath", "trainDigest", "initialPath", "initialDigest", "outputDirectory", "config", "configDigest"}
    if set(r) != required or r["version"] != 1 or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != r["scriptDigest"]:
        fail()
    config = r["config"]
    if hashlib.sha256(canonical(config)).hexdigest() != r["configDigest"] or config["steps"] != 64 or config["threads"] != 1:
        fail()
    train = [json.loads(line) for line in read(r["trainPath"], r["trainDigest"]).splitlines()]
    initial = json.loads(read(r["initialPath"], r["initialDigest"]))
    if len(train) != 64 or initial["format"] != "tj1-zero-state-v1" or initial["optimizer"] != {"momentum": None, "completedSteps": "0"}:
        fail()
    if initial["configDigest"] != r["configDigest"] or initial["dataPosition"] != "0" or initial["seed"] != 103:
        fail()
    if initial["tensors"]["weight"]["bits"] != "0" * 192 or initial["tensors"]["bias"]["bits"] != "0" * 32:
        fail()
    import torch
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.manual_seed(103)
    torch.use_deterministic_algorithms(True)
    decode = lambda h: struct.unpack(">d", bytes.fromhex(h))[0]
    x = torch.tensor([[decode(h) for h in row["x"]] for row in train], dtype=torch.float64, device="cpu")
    y = torch.tensor([[decode(h) for h in row["y"]] for row in train], dtype=torch.float64, device="cpu")
    if tuple(x.shape) != (64, 6) or tuple(y.shape) != (64, 2):
        fail()
    model = torch.nn.Linear(6, 2, bias=True, device="cpu", dtype=torch.float64)
    # The saved, externally bound initial state is actually loaded, not just described.
    model.load_state_dict({"weight": torch.tensor([decode(initial["tensors"]["weight"]["bits"][i:i+16]) for i in range(0, 192, 16)], dtype=torch.float64).reshape(2, 6),
                           "bias": torch.tensor([decode(initial["tensors"]["bias"]["bits"][i:i+16]) for i in range(0, 32, 16)], dtype=torch.float64)}, strict=True)
    optimizer = torch.optim.SGD(model.parameters(), lr=decode(config["learningRateBits"]), momentum=decode(config["momentumBits"]),
                                dampening=0, weight_decay=0, nesterov=False, foreach=False, fused=False)
    sequence = 0

    def emit(kind, data):
        nonlocal sequence
        sequence += 1
        frame = {"protocol": "TJ1_WORKER_V1", "stage": "trainer", "launchId": r["launchId"], "manifestDigest": r["manifestDigest"],
                 "sequence": str(sequence), "kind": kind, "data": data}
        raw = canonical(frame)
        if len(raw) > 8192:
            fail()
        sys.stdout.buffer.write(raw + b"\n")
        sys.stdout.buffer.flush()

    def permit(command, step):
        line = sys.stdin.buffer.readline(8193)
        if len(line) > 8192:
            fail()
        value = json.loads(line)
        if value != {"command": command, "step": str(step), "launchId": r["launchId"], "manifestDigest": r["manifestDigest"]}:
            fail()

    rss, available = memory()
    if available < 1073741824 or rss > 1610612736 or torch.get_num_threads() != 1 or torch.get_num_interop_threads() != 1:
        fail()
    emit("READY", {"runtime": "torch:" + torch.__version__, "rssBytes": str(rss), "availableBytes": str(available)})
    permit("START", 0)
    for step in range(1, 65):
        optimizer.zero_grad(set_to_none=True)
        loss = ((model(x) - y) ** 2).mean()
        loss.backward()
        if any(p.device.type != "cpu" or p.dtype != torch.float64 or p.grad is None or not torch.isfinite(p.grad).all() for p in model.parameters()):
            fail()
        gradient = tensor_record(model.weight.grad, model.bias.grad)
        optimizer.step()
        rss, available = memory()
        if available < 1073741824 or rss > 1610612736:
            fail()
        emit("STEP", {"step": str(step), "lossBits": bits(loss.item()), "gradient": gradient,
                      "tensors": tensor_record(model.weight, model.bias), "rssBytes": str(rss)})
        permit("NEXT" if step < 64 else "EXPORT", step)
    output = Path(r["outputDirectory"])
    checkpoint = {"format": "tj1-full-checkpoint-v1", "model": model.state_dict(), "optimizer": optimizer.state_dict(),
                  "torch_rng_state": torch.get_rng_state(), "completed_steps": 64, "data_position": 0,
                  "config": config, "config_digest": r["configDigest"], "train_digest": r["trainDigest"], "initial_digest": r["initialDigest"],
                  "manifest_digest": r["manifestDigest"], "trainer_digest": r["scriptDigest"], "seed": 103, "torch_version": str(torch.__version__)}
    with (output / "checkpoint.pt").open("xb") as f:
        class LimitedWriter:
            def write(self, value):
                if f.tell() + len(value) > MAX_FILE:
                    fail()
                return f.write(value)
            def flush(self):
                return f.flush()
            def tell(self):
                return f.tell()
        torch.save(checkpoint, LimitedWriter())
        f.flush()
        os.fsync(f.fileno())
    weights = canonical({"format": "tj1-weights-v1", "tensors": tensor_record(model.weight, model.bias)})
    if len(weights) > MAX_FILE:
        fail()
    with (output / "weights.json").open("xb") as f:
        f.write(weights)
        f.flush()
        os.fsync(f.fileno())
    if any((output / name).stat().st_size > MAX_FILE for name in ("checkpoint.pt", "weights.json")):
        fail()
    emit("EXPORTED", {"checkpoint": "checkpoint.pt", "weights": "weights.json", "rssBytes": str(memory()[0])})


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # The parent retains only a bounded private prefix; public errors remain fixed codes.
        traceback.print_exc(limit=16, file=sys.stderr)
        sys.exit(1)
