"""The three read-out arms under comparison (JEV-03 contract section 4).

M0  frozen JEV-02 M1 head: z_i = w . LN(h_i) with w in R^5120 (5120 params), trained in JEV-02
    on the old data. It is the same function class as C, so C-vs-M0 isolates the new supervision.
C   shared candidate scorer:      z_i = w . LN(h_i), w in R^5120, no bias (5120 params), new data.
Q   final-query classifier:       z   = W . LN(hq),  W in R^{4x5120}, no bias (20480 params).

C's four logits are produced in *display* order, so callers must map them through
the presentation order before comparing with stable class ids. Q emits logits
already in stable order (PLAYER_FIRST, NPC_FIRST, NO_PRIORITY_REQUEST,
NEEDS_CLARIFICATION) and never looks at the display order, which is exactly the
structural difference this round measures.
"""
from __future__ import annotations

import sys
from pathlib import Path

import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import j3config as R  # noqa: E402

HIDDEN = 5120
LN_EPS = 1e-5  # matches torch F.layer_norm default used by the frozen M1 head


class CandidateHead(nn.Module):
    """Shared projection: one 5120-vector scores every candidate."""

    def __init__(self) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(HIDDEN, elementwise_affine=False, eps=LN_EPS)
        self.score = nn.Linear(HIDDEN, 1, bias=False)

    def forward(self, cand: torch.Tensor) -> torch.Tensor:
        # cand: [batch, 4, 5120] -> [batch, 4]
        if cand.ndim != 3 or cand.shape[1] != len(R.CLASSES) or cand.shape[2] != HIDDEN:
            raise ValueError(f"cand must be [B,{len(R.CLASSES)},{HIDDEN}], got {tuple(cand.shape)}")
        if torch.isnan(cand).any():
            raise ValueError("cand contains NaN")
        return self.score(self.norm(cand)).squeeze(-1)


class QueryHead(nn.Module):
    """Classifier on the final assistant-prefix token; outputs stable order."""

    def __init__(self) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(HIDDEN, elementwise_affine=False, eps=LN_EPS)
        self.out = nn.Linear(HIDDEN, len(R.CLASSES), bias=False)

    def forward(self, hq: torch.Tensor) -> torch.Tensor:
        if hq.ndim != 2 or hq.shape[1] != HIDDEN:
            raise ValueError(f"hq must be [B,{HIDDEN}], got {tuple(hq.shape)}")
        if torch.isnan(hq).any():
            raise ValueError("hq contains NaN")
        return self.out(self.norm(hq))


def build(arm: str) -> nn.Module:
    if arm == "C":
        return CandidateHead()
    if arm == "Q":
        return QueryHead()
    raise ValueError(f"arm {arm!r} has no trainable head (M0 is frozen)")


def count_parameters(module: nn.Module) -> int:
    return int(sum(p.numel() for p in module.parameters() if p.requires_grad))


def save_head(module: nn.Module, path: Path, meta: dict) -> dict:
    from safetensors.torch import save_file
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {key: tensor.detach().to(torch.float32).contiguous().cpu()
             for key, tensor in module.state_dict().items()}
    save_file(state, str(path))
    return {"path": str(path), "fileSha256": R.sha256_file(path),
            "tensorSha256": R.state_hash(state), "params": count_parameters(module),
            "meta": meta}


def load_trained(arm: str, path: Path) -> nn.Module:
    from safetensors.torch import load_file

    module = build(arm)
    state = load_file(str(path))
    module.load_state_dict(state)
    module.eval()
    return module
