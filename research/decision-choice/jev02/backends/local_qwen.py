"""B: one frozen Qwen instance, four-GPU shard, batch 1, bf16, no HTTP."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C  # noqa: E402
from contracts import CAPS, LETTERS, MODEL_PATH, ORDERS, sha256_json, sha256_text  # noqa: E402
from render import rendered_chat  # noqa: E402


class LocalQwen:
    def __init__(self):
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH))
        self.label_ids = {letter: self.tokenizer.encode(letter, add_special_tokens=False)[0] for letter in LETTERS}
        if len(set(self.label_ids.values())) != 4:
            raise RuntimeError(f"label tokens are not distinct: {self.label_ids}")
        torch.cuda.empty_cache()
        free = [torch.cuda.mem_get_info(i)[0] / 2**30 for i in range(torch.cuda.device_count())]
        if min(free) < 32:
            raise RuntimeError(f"GPU guard: free GiB {['%.1f' % f for f in free]} < 32")
        started = time.time()
        self.model = AutoModelForCausalLM.from_pretrained(
            str(MODEL_PATH), dtype=torch.bfloat16, device_map="auto",
            max_memory={i: f"{CAPS['per_gpu_gib']}GiB" for i in range(torch.cuda.device_count())},
            low_cpu_mem_usage=True,
        )
        self.load_seconds = time.time() - started
        self.model.eval()
        for param in self.model.parameters():
            param.requires_grad_(False)
        self.params = sum(p.numel() for p in self.model.parameters())
        self.devices = sorted({str(p.device) for p in self.model.parameters()})
        self.identity = {
            "class": type(self.model).__name__, "params": self.params, "devices": self.devices,
            "loadSeconds": round(self.load_seconds, 3), "model": C.model_fingerprint(),
            "gpuPeakAfterLoadGiB": {str(i): round(torch.cuda.max_memory_allocated(i) / 2**30, 2)
                                    for i in range(torch.cuda.device_count())},
        }

    @torch.no_grad()
    def features(self, case: dict, order_index: int) -> dict:
        built = rendered_chat(self.tokenizer, case, order_index, "label")
        ids = torch.tensor([built["ids"]], device="cuda:0")
        started = time.time()
        out = self.model.model(input_ids=ids, use_cache=False)
        torch.cuda.synchronize()
        prefill_ms = (time.time() - started) * 1000
        hidden = out.last_hidden_state[0]
        cand = hidden[built["positions"]].float().cpu()
        hq = hidden[built["final"]].float().cpu()
        logits = self.model.lm_head(hidden[built["final"]]).float()
        logprobs = torch.log_softmax(logits, dim=-1)
        letter_logp = {letter: float(logprobs[self.label_ids[letter]]) for letter in LETTERS}
        probs = torch.exp(torch.tensor([letter_logp[letter] for letter in LETTERS]))
        mass = float(probs.sum())
        return {
            "cand": cand, "hq": hq,
            "letterLogp": [letter_logp[letter] for letter in LETTERS],
            "candidateMass": mass,
            "tokensIn": len(built["ids"]), "prefillMs": round(prefill_ms, 3),
            "positions": built["positions"], "final": built["final"],
            "idsSha256": sha256_json(built["ids"]),
            "renderedSha256": sha256_text(built["rendered"]),
        }

    @torch.no_grad()
    def generate_timed(self, case: dict, order_index: int) -> dict:
        built = rendered_chat(self.tokenizer, case, order_index, "json")
        started = time.time()
        ids = torch.tensor([built["ids"]], device="cuda:0")
        tokenize_ms = (time.time() - started) * 1000
        eos = self.tokenizer.eos_token_id
        started = time.time()
        out = self.model.model(input_ids=ids, use_cache=True)
        torch.cuda.synchronize()
        prefill_ms = (time.time() - started) * 1000
        past = out.past_key_values
        hidden = out.last_hidden_state[:, -1]
        readout_ms = 0.0
        started = time.time()
        logits = self.model.lm_head(hidden)
        readout_ms += (time.time() - started) * 1000
        next_id = int(torch.argmax(logits, dim=-1))
        generated = [next_id]
        decode_ms = 0.0
        while next_id != eos and len(generated) < CAPS["max_new_tokens"]:
            started = time.time()
            out = self.model.model(input_ids=torch.tensor([[next_id]], device="cuda:0"),
                                   past_key_values=past, use_cache=True)
            torch.cuda.synchronize()
            decode_ms += (time.time() - started) * 1000
            past = out.past_key_values
            hidden = out.last_hidden_state[:, -1]
            started = time.time()
            logits = self.model.lm_head(hidden)
            readout_ms += (time.time() - started) * 1000
            next_id = int(torch.argmax(logits, dim=-1))
            generated.append(next_id)
        text = self.tokenizer.decode(generated, skip_special_tokens=False)
        return {"rawText": text, "newTokens": len(generated), "tokensIn": len(built["ids"]),
                "tokenizeMs": round(tokenize_ms, 3), "prefillMs": round(prefill_ms, 3),
                "readoutMs": round(readout_ms, 3), "decodeMs": round(decode_ms, 3),
                "e2eMs": round(tokenize_ms + prefill_ms + readout_ms + decode_ms, 3),
                "prefillCalls": 1, "decodeCalls": len(generated),
                "idsSha256": sha256_json(built["ids"]), "renderedSha256": sha256_text(built["rendered"])}

    @torch.no_grad()
    def forward_timed(self, case: dict, order_index: int, head=None) -> dict:
        built = rendered_chat(self.tokenizer, case, order_index, "label")
        started = time.time()
        ids = torch.tensor([built["ids"]], device="cuda:0")
        tokenize_ms = (time.time() - started) * 1000
        started = time.time()
        out = self.model.model(input_ids=ids, use_cache=False)
        torch.cuda.synchronize()
        prefill_ms = (time.time() - started) * 1000
        hidden = out.last_hidden_state[0]
        cand = hidden[built["positions"]].float()
        hq = hidden[built["final"]].float()
        started = time.time()
        if head is None:
            logits = self.model.lm_head(hidden[built["final"]]).float()
            logprobs = torch.log_softmax(logits, dim=-1)
            value = {"letterLogp": [float(logprobs[self.label_ids[letter]]) for letter in LETTERS]}
        else:
            device = next(head.parameters()).device
            value = {"headLogits": [float(v) for v in head(cand.to(device).unsqueeze(0))[0]]}
        readout_ms = (time.time() - started) * 1000
        return {**value, "tokensIn": len(built["ids"]), "tokenizeMs": round(tokenize_ms, 3),
                "prefillMs": round(prefill_ms, 3), "readoutMs": round(readout_ms, 3),
                "decodeMs": 0.0, "e2eMs": round(tokenize_ms + prefill_ms + readout_ms, 3),
                "prefillCalls": 1, "decodeCalls": 0,
                "idsSha256": sha256_json(built["ids"]), "renderedSha256": sha256_text(built["rendered"])}

    def memory(self) -> dict:
        return {str(i): {"allocatedGiB": round(torch.cuda.memory_allocated(i) / 2**30, 2),
                         "reservedGiB": round(torch.cuda.memory_reserved(i) / 2**30, 2),
                         "peakGiB": round(torch.cuda.max_memory_allocated(i) / 2**30, 2)}
                for i in range(torch.cuda.device_count())}
