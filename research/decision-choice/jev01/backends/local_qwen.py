"""B: ONE frozen Qwen instance, four-GPU sharded, batch 1, bf16.

- Feature forward:  model.model(..., use_cache=False) -> last_hidden_state only.
  h_i = last token of candidate i, h_q = last token of the decision prefix.
- L: the SAME forward, then lm_head(h_q) restricted to the four label tokens
  (full-vocabulary log-softmax normalisation is recorded, never invented).
- J: greedy generation from the same prompt plus a protocol tail only.

No HTTP, one process, one loaded model. Every model job is written to the
ledger with input/output token counts and real wall time.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import (  # noqa: E402
    CAPS, LETTERS, MAX_NEW_TOKENS, ORDERS, Job, Ledger, dataset_hashes,
    model_fingerprint, runtime_fingerprint, sha256_json, sha256_text, write_json,
)

J_TAIL = "\n只输出一个 JSON 对象：{\"selectedId\":\"A\"}（A-D 是上面的显示标签）"


def build_user_text(common: str, arm: str) -> str:
    """J adds ONLY the protocol tail; L/H use the common bytes unchanged."""
    return common + J_TAIL if arm == "json" else common


def candidate_end_tokens(tokenizer, rendered: str, common: str, order_index: int) -> tuple[list[int], int]:
    """Token indices for each candidate description end and the decision position.

    Positions come from re-tokenizing exact prefixes and checking byte-prefix
    equality of the ids; no string search over token text and no padding index.
    """
    full = tokenizer(rendered, add_special_tokens=False)["input_ids"]
    positions: list[int] = []
    cursor = common.find("候选：")
    if cursor < 0:
        raise ValueError("candidate header missing")
    for letter, stable in zip(LETTERS, ORDERS[order_index]):
        needle = f"{letter}. "
        line_start = common.find(needle, cursor)
        if line_start < 0:
            raise ValueError(f"candidate {letter} missing")
        line_end = common.find("\n", line_start)
        if line_end < 0:
            line_end = len(common)
        # Prefix through the description text, then map into the rendered chat.
        prefix_common = common[:line_end]
        marker = prefix_common
        pos_in_rendered = rendered.find(marker)
        if pos_in_rendered < 0:
            raise ValueError("rendered chat does not contain the common text")
        prefix_rendered = rendered[:pos_in_rendered + len(marker)]
        prefix_ids = tokenizer(prefix_rendered, add_special_tokens=False)["input_ids"]
        if full[:len(prefix_ids)] != prefix_ids:
            raise ValueError(f"tokenization is not prefix-stable at candidate {letter}")
        positions.append(len(prefix_ids) - 1)
        cursor = line_end
    final = len(full) - 1
    if len(set(positions)) != 4 or max(positions) >= final:
        raise ValueError(f"bad candidate positions {positions} final {final}")
    return positions, final


class LocalQwen:
    def __init__(self, model_path: Path, max_memory_gib: int = 20, device: str = "auto"):
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.model_path = Path(model_path)
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.model_path))
        self.label_ids = {letter: self.tokenizer.encode(letter, add_special_tokens=False)[0] for letter in LETTERS}
        if len(set(self.label_ids.values())) != 4:
            raise RuntimeError(f"label tokens are not distinct single tokens: {self.label_ids}")
        self.device = device
        torch.cuda.empty_cache()
        free = [torch.cuda.mem_get_info(i)[0] / 2**30 for i in range(torch.cuda.device_count())]
        if min(free) < 32:
            raise RuntimeError(f"GPU guard: free GiB {['%.1f' % f for f in free]} < 32 before load")
        t0 = time.time()
        self.model = AutoModelForCausalLM.from_pretrained(
            str(self.model_path), dtype=torch.bfloat16, device_map="auto",
            max_memory={i: f"{max_memory_gib}GiB" for i in range(torch.cuda.device_count())},
            low_cpu_mem_usage=True,
        )
        self.load_seconds = time.time() - t0
        self.model.eval()
        for param in self.model.parameters():
            param.requires_grad_(False)
        self.params = sum(p.numel() for p in self.model.parameters())
        self.devices = sorted({str(p.device) for p in self.model.parameters()})
        self.identity = {
            "class": type(self.model).__name__,
            "params": self.params,
            "devices": self.devices,
            "loadSeconds": round(self.load_seconds, 3),
            "model": model_fingerprint(),
            "runtime": runtime_fingerprint(),
            "gpuPeakAfterLoadGiB": {str(i): round(torch.cuda.max_memory_allocated(i) / 2**30, 2) for i in range(torch.cuda.device_count())},
        }

    # ------------------------------------------------------------------
    @torch.no_grad()
    def forward_hidden(self, input_ids: torch.Tensor):
        return self.model.model(input_ids=input_ids, use_cache=False, output_hidden_states=False)

    @torch.no_grad()
    def features(self, case: dict, common: str, order_index: int):
        rendered = self.tokenizer.apply_chat_template(
            [{"role": "user", "content": common}], tokenize=False,
            add_generation_prompt=True, enable_thinking=False,
        )
        ids = self.tokenizer(rendered, add_special_tokens=False, return_tensors="pt")["input_ids"].to("cuda:0")
        positions, final = candidate_end_tokens(self.tokenizer, rendered, common, order_index)
        out = self.forward_hidden(ids)
        hidden = out.last_hidden_state[0]  # [T, H]
        cand = hidden[positions].float().cpu()
        hq = hidden[final].float().cpu()
        logits = self.model.lm_head(hidden[final]).float()
        logprobs = torch.log_softmax(logits, dim=-1)
        letter_logp = {letter: float(logprobs[self.label_ids[letter]]) for letter in LETTERS}
        probs = {letter: float(torch.exp(torch.tensor(letter_logp[letter]))) for letter in LETTERS}
        mass = sum(probs.values())
        conditional = {letter: probs[letter] / mass for letter in LETTERS}
        # top-1 sanity only; the head is what this experiment trains.
        top = int(torch.argmax(logprobs))
        return {
            "cand": cand,
            "hq": hq,
            "letterLogp": letter_logp,
            "candidateMass": mass,
            "conditional": conditional,
            "vocabLogpTopId": top,
            "tokensIn": int(ids.shape[1]),
            "renderedSha256": sha256_text(rendered),
            "idsSha256": sha256_json(ids[0].tolist()),
            "positions": positions,
            "final": final,
            "candidateLetters": [LETTERS[i] for i in range(4)],
            "order": ORDERS[order_index],
        }

    # ------------------------------------------------------------------
    @torch.no_grad()
    def generate(self, common: str, order_index: int) -> dict:
        rendered = self.tokenizer.apply_chat_template(
            [{"role": "user", "content": build_user_text(common, "json")}], tokenize=False,
            add_generation_prompt=True, enable_thinking=False,
        )
        ids = self.tokenizer(rendered, add_special_tokens=False, return_tensors="pt")["input_ids"].to("cuda:0")
        out = self.model.generate(
            input_ids=ids, max_new_tokens=MAX_NEW_TOKENS, do_sample=False,
            use_cache=True, pad_token_id=self.tokenizer.pad_token_id or self.tokenizer.eos_token_id,
            eos_token_id=self.tokenizer.eos_token_id,
        )
        new_ids = out[0, ids.shape[1]:].tolist()
        text = self.tokenizer.decode(new_ids, skip_special_tokens=False)
        return {
            "rawText": text,
            "newTokens": len(new_ids),
            "tokensIn": int(ids.shape[1]),
            "renderedSha256": sha256_text(rendered),
            "idsSha256": sha256_json(ids[0].tolist()),
            "order": ORDERS[order_index],
        }

    # ------------------------------------------------------------------
    @torch.no_grad()
    def generate_timed(self, common: str, order_index: int) -> dict:
        """Manual greedy decode so prefill/decode are measured, not guessed."""
        t0 = time.perf_counter()
        rendered = self.tokenizer.apply_chat_template(
            [{"role": "user", "content": build_user_text(common, "json")}], tokenize=False,
            add_generation_prompt=True, enable_thinking=False,
        )
        ids = self.tokenizer(rendered, add_special_tokens=False, return_tensors="pt")["input_ids"].to("cuda:0")
        tokenize_ms = (time.perf_counter() - t0) * 1000
        eos = self.tokenizer.eos_token_id
        t0 = time.perf_counter()
        out = self.model.model(input_ids=ids, use_cache=True)
        torch.cuda.synchronize()
        prefill_ms = (time.perf_counter() - t0) * 1000
        past = out.past_key_values
        hidden = out.last_hidden_state[:, -1]
        logits = self.model.lm_head(hidden)
        readout_ms = 0.0
        next_id = int(torch.argmax(logits, dim=-1))
        generated = [next_id]
        decode_ms = 0.0
        steps = 0
        while next_id != eos and steps < MAX_NEW_TOKENS:
            steps += 1
            t0 = time.perf_counter()
            out = self.model.model(input_ids=torch.tensor([[next_id]], device="cuda:0"),
                                   past_key_values=past, use_cache=True)
            torch.cuda.synchronize()
            decode_ms += (time.perf_counter() - t0) * 1000
            past = out.past_key_values
            hidden = out.last_hidden_state[:, -1]
            t0 = time.perf_counter()
            logits = self.model.lm_head(hidden)
            readout_ms += (time.perf_counter() - t0) * 1000
            next_id = int(torch.argmax(logits, dim=-1))
            generated.append(next_id)
        text = self.tokenizer.decode(generated, skip_special_tokens=False)
        return {
            "rawText": text, "newTokens": len(generated),
            "tokensIn": int(ids.shape[1]),
            "tokenizeMs": round(tokenize_ms, 3),
            "prefillMs": round(prefill_ms, 3),
            "readoutMs": round(readout_ms, 3),
            "decodeMs": round(decode_ms, 3),
            "e2eMs": round(tokenize_ms + prefill_ms + readout_ms + decode_ms, 3),
            "prefillCalls": 1, "decodeCalls": len(generated),
            "renderedSha256": sha256_text(rendered),
            "idsSha256": sha256_json(ids[0].tolist()),
            "order": ORDERS[order_index],
        }

    @torch.no_grad()
    def forward_timed(self, common: str, order_index: int, with_head=None):
        """One full, uncached forward (L or H); optional head readout timed apart."""
        t0 = time.perf_counter()
        rendered = self.tokenizer.apply_chat_template(
            [{"role": "user", "content": common}], tokenize=False,
            add_generation_prompt=True, enable_thinking=False,
        )
        ids = self.tokenizer(rendered, add_special_tokens=False, return_tensors="pt")["input_ids"].to("cuda:0")
        tokenize_ms = (time.perf_counter() - t0) * 1000
        positions, final = candidate_end_tokens(self.tokenizer, rendered, common, order_index)
        t0 = time.perf_counter()
        out = self.model.model(input_ids=ids, use_cache=False)
        torch.cuda.synchronize()
        prefill_ms = (time.perf_counter() - t0) * 1000
        hidden = out.last_hidden_state[0]
        cand = hidden[positions].float()
        hq = hidden[final].float()
        t0 = time.perf_counter()
        if with_head is None:
            logits = self.model.lm_head(hidden[final]).float()
            letter_logp = {letter: float(torch.log_softmax(logits, dim=-1)[self.label_ids[letter]]) for letter in LETTERS}
            out_value = {"letterLogp": letter_logp}
        else:
            out_value = {"headLogits": [float(v) for v in with_head(cand.cpu().unsqueeze(0), hq.cpu().unsqueeze(0))[0]]}
        readout_ms = (time.perf_counter() - t0) * 1000
        return {
            **out_value,
            "tokensIn": int(ids.shape[1]),
            "tokenizeMs": round(tokenize_ms, 3),
            "prefillMs": round(prefill_ms, 3),
            "readoutMs": round(readout_ms, 3),
            "decodeMs": 0.0,
            "e2eMs": round(tokenize_ms + prefill_ms + readout_ms, 3),
            "prefillCalls": 1, "decodeCalls": 0,
            "positions": positions, "final": final,
            "renderedSha256": sha256_text(rendered),
            "idsSha256": sha256_json(ids[0].tolist()),
        }

    # ------------------------------------------------------------------
    def memory(self) -> dict:
        return {str(i): {
            "allocatedGiB": round(torch.cuda.memory_allocated(i) / 2**30, 2),
            "reservedGiB": round(torch.cuda.memory_reserved(i) / 2**30, 2),
            "peakGiB": round(torch.cuda.max_memory_allocated(i) / 2**30, 2),
        } for i in range(torch.cuda.device_count())}

    def reset_peak(self) -> None:
        for i in range(torch.cuda.device_count()):
            torch.cuda.reset_peak_memory_stats(i)
