"""Real joint candidate encoding. One rendered request -> one backbone forward.

Consumes the existing TypeScript renderer's text and UTF-16 spans; it does not
reconstruct incomplete legacy cases. This is an experimental action renderer,
not a transfer of the old priority-task calibration certificate.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import math
import struct
import time

import numpy as np

MIB = 1024 ** 2
GIB = 1024 ** 3
ROOT = Path(__file__).resolve().parents[4]


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def utf16_position(text: str, units: int) -> int:
    """JS string offset -> Python Unicode offset; reject half a surrogate."""
    raw = text.encode("utf-16-le")
    if type(units) is not int or not 0 <= units <= len(raw) // 2:
        raise ValueError("UTF-16 position outside the rendered text")
    return len(raw[:units * 2].decode("utf-16-le"))


def prepare(tokenizer, envelope: dict, max_tokens: int = 2048) -> dict:
    if envelope.get("schema") != "frostecho.joint-encoding-request/1":
        raise ValueError("use export-encoding-request.mjs; legacy case text is insufficient")
    request = envelope["request"]
    raw = envelope["requestJson"]
    if json.loads(raw) != request or digest_bytes(raw.encode()) != envelope["inputSha256"]:
        raise ValueError("request bytes/hash mismatch")
    renderer_sha = file_sha(ROOT / "src/r7/jev/render.ts")
    if envelope["rendererSourceSha256"] != renderer_sha:
        raise ValueError("prepared request belongs to a different renderer")
    candidates = request["candidates"]
    ids = [row["id"] for row in candidates]
    if not 2 <= len(ids) <= 8 or len(set(ids)) != len(ids):
        raise ValueError("require 2..8 unique actual candidates")
    built = envelope["rendered"]
    text = built["text"]
    if built.get("spanUnit") != "utf16-code-unit":
        raise ValueError("renderer spans must declare JS UTF-16 units")
    if digest_bytes(text.encode()) != envelope["renderedTextSha256"]:
        raise ValueError("rendered text/hash mismatch")
    spans = built["candidateSpans"]
    if len(spans) != len(ids):
        raise ValueError("candidate/span count mismatch")
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": text}], tokenize=False,
        add_generation_prompt=True, enable_thinking=False)
    if rendered.count(text) != 1:
        raise ValueError("chat template must preserve exactly one joint message")
    message_start = rendered.index(text)
    tokens = tokenizer(rendered, add_special_tokens=False, truncation=False,
                       return_offsets_mapping=True)
    token_ids, offsets = tokens["input_ids"], tokens["offset_mapping"]
    if len(token_ids) > max_tokens or len(token_ids) != len(offsets):
        raise ValueError("token budget/offset mismatch; no silent truncation")
    positions, previous_end = [], 0
    for i, span in enumerate(spans):
        begin, end = utf16_position(text, span["start"]), utf16_position(text, span["end"])
        if span["index"] != i or not previous_end <= begin < end:
            raise ValueError("candidate spans overlap or have wrong identity")
        previous_end = end
        character = message_start + end - 1
        matches = [j for j, (a, b) in enumerate(offsets) if a <= character < b]
        if len(matches) != 1:
            raise ValueError("candidate endpoint does not map to one real token")
        positions.append(matches[0])
    if len(set(positions)) != len(ids):
        raise ValueError("candidate readout positions collided")
    return {
        "tokenIds": token_ids, "positions": positions, "candidateIds": ids,
        "inputSha256": envelope["inputSha256"], "rendererId": built["rendererId"],
        "rendererSourceSha256": renderer_sha,
        "renderedTextSha256": digest_bytes(rendered.encode()),
        "tokenIdsSha256": digest_bytes(json.dumps(token_ids, separators=(",", ":")).encode()),
        "candidateSetHash": request["candidateSetHash"],
    }


def memory_plan(physical_gpu: int) -> dict:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True, timeout=20)
    free = {int(row.split(",")[0]): int(row.split(",")[1])
            for row in result.stdout.strip().splitlines()}
    mem = {line.split(":")[0]: int(line.split()[1]) for line in
           Path("/proc/meminfo").read_text().splitlines() if len(line.split()) >= 2}
    gpu_mib = free[physical_gpu] - 1536
    cpu_bytes = min(55 * GIB, mem["MemAvailable"] * 1024 - 12 * GIB)
    if gpu_mib < 1024 or cpu_bytes < 16 * GIB:
        raise RuntimeError("insufficient measured memory after reserves")
    # HF integer memory limits are BYTES, not MiB.
    return {"physicalGpu": physical_gpu, "freeGpuMiB": free[physical_gpu],
            "availableRamMiB": mem["MemAvailable"] // 1024,
            "maxMemoryBytes": {0: gpu_mib * MIB, "cpu": cpu_bytes}}


class JointEncoder:
    """Persistent loader reusable by the online scorer and corpus encoder."""

    def __init__(self, model_path: Path, output: Path, physical_gpu: int = 1,
                 placement: str = "auto"):
        if os.environ.get("CUDA_VISIBLE_DEVICES") != str(physical_gpu):
            raise ValueError("set CUDA_VISIBLE_DEVICES before importing torch")
        import torch
        import transformers
        from transformers import AutoModelForCausalLM, AutoTokenizer
        if torch.cuda.device_count() != 1:
            raise ValueError("exactly one explicitly selected GPU must be visible")
        self.torch = torch
        torch.set_num_threads(min(8, os.cpu_count() or 1))
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(model_path), local_files_only=True, trust_remote_code=False)
        # device_count can use NVML without creating an allocator/context.
        # PyTorch 2.5 requires an initialized device before resetting its stats.
        torch.cuda.init()
        plan = memory_plan(physical_gpu)
        device_map, placement_evidence = "auto", {"strategy": "auto"}
        if placement == "one-layer-offload":
            device_map, placement_evidence = one_layer_plan(model_path, plan["maxMemoryBytes"][0])
        elif placement != "auto":
            raise ValueError("unknown placement strategy")
        torch.cuda.reset_peak_memory_stats(0)
        started = time.monotonic()
        model, loading = AutoModelForCausalLM.from_pretrained(
            str(model_path), torch_dtype=torch.bfloat16, device_map=device_map,
            max_memory=plan["maxMemoryBytes"], low_cpu_mem_usage=True,
            offload_folder=str(output / "offload"), local_files_only=True,
            trust_remote_code=False, output_loading_info=True, attn_implementation="eager")
        if any(loading.get(key) for key in ("missing_keys", "mismatched_keys", "error_msgs")):
            raise ValueError(f"checkpoint did not load fully: {loading}")
        if getattr(model, "is_loaded_in_4bit", False) or getattr(model, "is_loaded_in_8bit", False):
            raise ValueError("no quantization in this continuation")
        model.eval()
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        self.model, self.base = model, model.model
        embeddings = model.get_input_embeddings()
        hook_device = getattr(getattr(embeddings, "_hf_hook", None), "execution_device", None)
        self.input_device = hook_device if hook_device is not None else embeddings.weight.device
        if placement == "one-layer-offload":
            # RoPE has nonpersistent buffers, absent from the checkpoint index.
            # Calling the text base directly bypasses a parent dispatch hook;
            # keep these small buffers beside the embedding execution output.
            self.base.rotary_emb.to(self.input_device)
        actual_bytes = {}
        for parameter in model.parameters():
            device = str(parameter.device)
            actual_bytes[device] = actual_bytes.get(device, 0) + parameter.numel() * parameter.element_size()
        self.identity = {
            "modelPath": str(model_path), "class": type(model).__name__,
            "torch": torch.__version__, "transformers": transformers.__version__,
            "precision": "bfloat16", "quantization": "none", "attention": "eager",
            "deviceMap": {key: str(value) for key, value in getattr(model, "hf_device_map", {}).items()},
            "actualParameterBytesByDevice": actual_bytes,
            "rotaryBufferDevices": {name: str(value.device) for name, value in self.base.rotary_emb.named_buffers()},
            "placementNote": "An all-CPU auto placement may omit hf_device_map; report actual devices instead of claiming GPU placement.",
            "memoryPlan": plan, "loadSeconds": time.monotonic() - started,
            "placementEvidence": placement_evidence,
            "metadataSha256": {name: file_sha(model_path / name) for name in
                              ("config.json", "tokenizer_config.json", "model.safetensors.index.json")
                              if (model_path / name).exists()},
            "weightIdentityScope": "local checkpoint metadata; no new full-shard hash claim",
        }

    def encode(self, prepared: dict):
        torch = self.torch
        ids = torch.tensor([prepared["tokenIds"]], device=self.input_device, dtype=torch.long)
        started = time.monotonic()
        with torch.inference_mode():
            hidden = self.base(input_ids=ids, use_cache=False, return_dict=True).last_hidden_state
            if tuple(hidden.shape) != (1, len(prepared["tokenIds"]), 5120):
                raise ValueError(f"unexpected real hidden shape: {tuple(hidden.shape)}")
            vectors = hidden[0, prepared["positions"]].float().cpu().numpy()
        torch.cuda.synchronize()
        if not np.isfinite(vectors).all():
            raise ValueError("real features contain nonfinite values")
        trace = {
            **{key: value for key, value in prepared.items() if key != "tokenIds"},
            "tokens": len(prepared["tokenIds"]), "shape": list(vectors.shape),
            "forwardSeconds": time.monotonic() - started,
            "featureSha256": digest_bytes(vectors.astype(np.float32).tobytes()),
            "peakCudaAllocatedMiB": torch.cuda.max_memory_allocated(0) / MIB,
            "encoderForwardCalls": 1, "readout": "joint-candidate-end-token",
        }
        return vectors, trace


def one_layer_plan(model_path: Path, gpu_budget_bytes: int):
    """Measured BF16 placement for a shared card: one resident decoder block.

    Accelerate's default can place everything on CPU when the embedding and
    largest reserved block do not jointly fit. Pinning one small block selects
    GPU execution; Accelerate brings CPU blocks onto that device as needed.
    Bound resident + largest streamed block + activation reserve from headers.
    No weights are quantized and the unused LM head is kept on CPU.
    """
    config = json.loads((model_path / "config.json").read_text())
    layers = config.get("text_config", config)["num_hidden_layers"]
    index = json.loads((model_path / "model.safetensors.index.json").read_text())["weight_map"]
    headers = {}
    sizes = {f"model.layers.{i}": 0 for i in range(layers)}
    sizes["model.embed_tokens"] = 0
    sizes["model.norm"] = 0
    for name, shard in index.items():
        # Qwen3_5ForCausalLM loads the checkpoint's explicit text-model prefix
        # into runtime model.*. Headers still use the original checkpoint key.
        checkpoint_prefix = "model.language_model."
        runtime_name = ("model." + name[len(checkpoint_prefix):]
                        if name.startswith(checkpoint_prefix) else name)
        prefix = next((key for key in sizes if runtime_name.startswith(key + ".")), None)
        if prefix is None:
            continue
        if shard not in headers:
            with (model_path / shard).open("rb") as stream:
                length = struct.unpack("<Q", stream.read(8))[0]
                headers[shard] = json.loads(stream.read(length))
        sizes[prefix] += 2 * math.prod(headers[shard][name]["shape"])
    if any(size <= 0 for size in sizes.values()):
        raise ValueError("checkpoint module names do not match the verified text model")
    resident = min((key for key in sizes if key.startswith("model.layers.")), key=sizes.get)
    reserve = 512 * MIB
    bound = sizes[resident] + max(sizes.values()) + reserve
    if bound > gpu_budget_bytes:
        raise RuntimeError(f"one-layer placement needs {bound} bytes, budget {gpu_budget_bytes}")
    mapping = {key: (0 if key == resident else "cpu") for key in sizes}
    mapping["lm_head"] = "cpu"
    return mapping, {"strategy": "one-layer-offload", "residentModule": resident,
                     "residentBytes": sizes[resident], "largestStreamedBytes": max(sizes.values()),
                     "activationReserveBytes": reserve, "plannedPeakBoundBytes": bound,
                     "gpuBudgetBytes": gpu_budget_bytes, "boundScope": "weights plus fixed reserve; measured peak is authoritative"}
