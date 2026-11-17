"""C: the two frozen-backbone heads. LayerNorm has NO trainable parameters.

H0: z_i = w^T LN(h_i)
H1: k_i = Wc LN(h_i); q = Wq LN(h_q); z_i = q^T k_i / sqrt(rank) + v^T k_i
"""
from __future__ import annotations

import math

import torch
import torch.nn.functional as F
from torch import nn


def masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """logits [B,K], mask [B,K] bool. Padded candidates get -inf, never a score."""
    if logits.shape != mask.shape:
        raise ValueError(f"logits {tuple(logits.shape)} and mask {tuple(mask.shape)} differ")
    if not torch.isfinite(logits[mask]).all():
        raise ValueError("non-finite candidate logit")
    return logits.masked_fill(~mask, float("-inf"))


def masked_cross_entropy(logits: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    masked = masked_logits(logits, mask)
    if (~mask).all(dim=1).any():
        raise ValueError("a row has no valid candidates")
    if not torch.isfinite(masked.gather(1, target.unsqueeze(1))).all():
        raise ValueError("the target candidate is masked")
    return F.cross_entropy(masked, target)


class LinearHead(nn.Module):
    """H0, 5,120 trainable parameters at H=5120."""

    def __init__(self, hidden: int = 5120):
        super().__init__()
        self.w = nn.Parameter(torch.empty(hidden))
        nn.init.normal_(self.w, std=0.02)

    def forward(self, cand: torch.Tensor) -> torch.Tensor:
        if cand.ndim != 3:
            raise ValueError("cand must be [B,K,H]")
        x = F.layer_norm(cand.float(), (cand.shape[-1],))
        return x @ self.w

    def trainable_parameters(self) -> list[str]:
        return ["w"]


class PointerHead(nn.Module):
    """H1, rank 128: 1,310,848 trainable parameters at H=5120 (no v-bias)."""

    def __init__(self, hidden: int = 5120, rank: int = 128):
        super().__init__()
        self.rank = rank
        self.wq = nn.Parameter(torch.empty(hidden, rank))
        self.wc = nn.Parameter(torch.empty(hidden, rank))
        self.v = nn.Parameter(torch.empty(rank))
        for param in (self.wq, self.wc, self.v):
            nn.init.normal_(param, std=0.02)

    def forward(self, cand: torch.Tensor, hq: torch.Tensor) -> torch.Tensor:
        if cand.ndim != 3 or hq.ndim != 2:
            raise ValueError("cand must be [B,K,H] and hq [B,H]")
        if cand.shape[-1] != self.wc.shape[0] or hq.shape[-1] != self.wq.shape[0]:
            raise ValueError("hidden size differs from the head")
        keys = F.layer_norm(cand.float(), (cand.shape[-1],)) @ self.wc
        query = F.layer_norm(hq.float(), (hq.shape[-1],)) @ self.wq
        scores = torch.einsum("bkq,bq->bk", keys, query) / math.sqrt(self.rank)
        bias = torch.einsum("bkq,q->bk", keys, self.v)
        return scores + bias

    def trainable_parameters(self) -> list[str]:
        return ["wq", "wc", "v"]


def build_head(kind: str, hidden: int = 5120, rank: int = 128) -> nn.Module:
    if kind == "linear_head":
        return LinearHead(hidden)
    if kind == "pointer_head":
        return PointerHead(hidden, rank)
    raise ValueError(f"unknown head {kind}")
