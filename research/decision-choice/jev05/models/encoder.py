"""Actual frozen Qwen text features, never synthetic logits or token-ID features."""
from __future__ import annotations

import importlib.metadata
from pathlib import Path

import numpy as np

from contracts import RENDERER, digest, file_sha, read_json, render_candidates


def snapshot_identity(path, *, probe=False):
    root = Path(path).resolve()
    names = sorted({*root.glob("*.safetensors"), *root.glob("*.safetensors.index.json"),
                    *root.glob("config.json"), *root.glob("tokenizer*"),
                    *root.glob("special_tokens_map.json"), *root.glob("vocab.json"), *root.glob("merges.txt")})
    if not any(item.suffix == ".safetensors" for item in names):
        raise ValueError("local model must contain real safetensors weight files")
    files = [{"name": item.name, "size": item.stat().st_size,
              "sha256": None if probe and item.suffix == ".safetensors" else file_sha(item)}
             for item in names if item.is_file()]
    return {"snapshotSha256": digest(files), "files": files}


class QwenEncoder:
    def __init__(self, model_path, *, model_id, revision, device="auto", dtype="auto",
                 max_tokens=4096, pooling="last-token", batch_size=4,
                 load_in_4bit=False, max_memory=None, identity_mode="full"):
        if model_id not in ("Qwen/Qwen3.5-4B", "Qwen/Qwen3.5-27B"):
            raise ValueError("this encoder arm requires the named Qwen3.5-4B or 27B identity")
        if not revision or revision == "main":
            raise ValueError("pin the actual model revision; do not use mutable main")
        if max_tokens < 32 or batch_size < 1 or pooling not in ("last-token", "masked-mean"):
            raise ValueError("invalid token/batch/pooling configuration")
        root = Path(model_path).resolve()
        config_json = read_json(root / "config.json")
        if config_json.get("model_type") != "qwen3_5":
            raise ValueError("weights config is not qwen3_5")
        expected_hidden = config_json.get("text_config", {}).get("hidden_size")
        if expected_hidden not in (2560, 5120):
            raise ValueError(f"unexpected Qwen3.5 text hidden size {expected_hidden}")
        if (model_id.endswith("4B") and expected_hidden != 2560) or (model_id.endswith("27B") and expected_hidden != 5120):
            raise ValueError("declared model name disagrees with text architecture")
        if identity_mode not in ("full", "probe"):
            raise ValueError("identity mode must be full or probe")
        snapshot = snapshot_identity(root, probe=identity_mode == "probe")
        import torch
        from transformers import AutoModel, AutoTokenizer
        self.torch = torch
        self.batch_size, self.max_tokens, self.pooling = batch_size, max_tokens, pooling
        use_cuda = torch.cuda.is_available() and device != "cpu"
        dtype_name = ("bfloat16" if use_cuda else "float32") if dtype == "auto" else dtype
        if dtype_name not in ("float32", "float16", "bfloat16"):
            raise ValueError("dtype must be auto/float32/float16/bfloat16")
        kwargs = {"local_files_only": True, "trust_remote_code": False,
                  "torch_dtype": getattr(torch, dtype_name), "output_loading_info": True}
        if device == "auto":
            kwargs["device_map"] = "auto" if use_cuda else "cpu"
        else:
            kwargs["device_map"] = device
        if max_memory is not None:
            kwargs["max_memory"] = {int(key) if str(key).isdigit() else key: value for key, value in max_memory.items()}
        quantization = "none"
        if load_in_4bit:
            if not use_cuda:
                raise ValueError("4bit path requires a CUDA execution device")
            from transformers import BitsAndBytesConfig
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=getattr(torch, dtype_name))
            quantization = "bitsandbytes-nf4-double"
        self.tokenizer = AutoTokenizer.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        if self.tokenizer.pad_token_id is None:
            raise ValueError("tokenizer has no padding or EOS token")
        self.tokenizer.padding_side = "right"
        self.model, loading = AutoModel.from_pretrained(str(root), **kwargs)
        if loading.get("missing_keys") or loading.get("mismatched_keys") or loading.get("error_msgs"):
            raise ValueError(f"checkpoint did not fully load: {loading}")
        self.model.eval()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        self.text_model = getattr(self.model, "language_model", None)
        if self.text_model is None:
            nested = getattr(self.model, "model", None)
            self.text_model = getattr(nested, "language_model", None)
        if self.text_model is None:
            raise ValueError("loaded Qwen model has no text backbone; update the dedicated transformers environment")
        self.input_device = self.text_model.get_input_embeddings().weight.device
        self.dimension = expected_hidden
        self.identity = {
            "schema": "frostecho.jev05.encoder/1", "backend": "qwen-frozen",
            "evidenceClass": "real-model" if identity_mode == "full" else "real-model-probe",
            "model": model_id, "revision": revision, "identityMode": identity_mode,
            "upstreamRevisionVerified": revision not in ("unknown", "local-unknown", "unknown/unversioned"),
            "renderer": RENDERER, "pooling": pooling, "maxTokens": max_tokens,
            "truncation": "refuse", "dimension": expected_hidden, "dtype": dtype_name,
            "quantization": quantization, "snapshotSha256": snapshot["snapshotSha256"],
            "weightFiles": snapshot["files"], "torch": torch.__version__,
            "transformers": importlib.metadata.version("transformers"),
            "architecture": type(self.model).__name__,
        }
        self.identity["encoderSha256"] = digest(self.identity)

    def encode_texts(self, texts):
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32), []
        outputs, lengths = [], []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start:start + self.batch_size]
            tokens = self.tokenizer(batch, padding=True, truncation=False, return_tensors="pt")
            lens = tokens["attention_mask"].sum(dim=1).tolist()
            if max(lens) > self.max_tokens:
                raise ValueError(f"full context/candidate exceeds maxTokens={self.max_tokens}; lengths={lens}; no truncation was performed")
            inputs = {key: value.to(self.input_device) for key, value in tokens.items()
                      if key in ("input_ids", "attention_mask")}
            with self.torch.inference_mode():
                hidden = self.text_model(**inputs, use_cache=False, return_dict=True).last_hidden_state
                mask = inputs["attention_mask"].to(hidden.device)
                if self.pooling == "last-token":
                    positions = mask.sum(dim=1).long() - 1
                    pooled = hidden[self.torch.arange(hidden.shape[0], device=hidden.device), positions]
                else:
                    pooled = (hidden * mask.unsqueeze(-1)).sum(dim=1) / mask.sum(dim=1).unsqueeze(-1).clamp_min(1)
                array = pooled.float().cpu().numpy()
            if array.shape != (len(batch), self.dimension) or not np.isfinite(array).all():
                raise ValueError("encoder produced malformed/non-finite real features")
            outputs.append(array)
            lengths.extend(int(value) for value in lens)
        return np.concatenate(outputs), lengths

    def encode_case(self, case):
        return self.encode_texts(render_candidates(case))
