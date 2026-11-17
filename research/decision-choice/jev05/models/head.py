"""Shared scalar candidate head; NumPy CPU and PyTorch CUDA training."""
from __future__ import annotations

from pathlib import Path
import math
import time
import numpy as np

from contracts import digest, file_sha, read_json, write_json


def normalized(values):
    values = np.asarray(values, dtype=np.float32)
    if values.ndim != 2 or not np.isfinite(values).all():
        raise ValueError("features must be a finite rank-two matrix")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if (norms <= 0).any():
        raise ValueError("zero encoder vector cannot be scored")
    return values / norms


def softmax(values):
    values = np.asarray(values, dtype=np.float64)
    exps = np.exp(values - values.max())
    return exps / exps.sum()


def set_loss_gradient(logits, acceptable):
    """Stable -log P(acceptable set), and exact gradient wrt all logits."""
    logits = np.asarray(logits, dtype=np.float64)
    indices = np.asarray(acceptable, dtype=np.int64)
    if logits.ndim != 1 or not np.isfinite(logits).all() or not len(indices) or len(set(indices.tolist())) != len(indices) or (indices < 0).any() or (indices >= len(logits)).any():
        raise ValueError("invalid logits/acceptable indices")
    all_max = logits.max()
    accept_max = logits[indices].max()
    loss = all_max + np.log(np.exp(logits - all_max).sum()) - accept_max - np.log(np.exp(logits[indices] - accept_max).sum())
    gradient = softmax(logits)
    gradient[indices] -= softmax(logits[indices])
    return float(loss), gradient


def indices_for(case):
    ids = [candidate["id"] for candidate in case["candidates"]]
    return [ids.index(value) for value in case["acceptableIds"]]


def evaluate(weights, cases, features):
    correct, losses = 0, []
    for case in cases:
        values = features[case["caseId"]] @ weights
        acceptable = indices_for(case)
        losses.append(set_loss_gradient(values, acceptable)[0])
        correct += int(int(np.argmax(values)) in acceptable)
    return {"cases": len(cases), "top1InAcceptable": correct / len(cases) if cases else None,
            "setNll": float(np.mean(losses)) if losses else None}


def save_checkpoint(root, weights, metadata, optimizer=None):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    weights = np.asarray(weights, dtype=np.float32)
    path = root / "weights.npy"
    with path.with_suffix(".tmp").open("wb") as handle:
        np.save(handle, weights, allow_pickle=False)
    path.with_suffix(".tmp").replace(path)
    optimizer_sha = None
    if optimizer is not None:
        opt_path = root / "optimizer.npz"
        np.savez(opt_path, **optimizer)
        optimizer_sha = file_sha(opt_path)
    manifest = {"schema": "frostecho.jev05.shared-scalar/1", "head": "l2-linear-scalar/1",
                "dimension": int(weights.size), "normalization": "per-candidate-l2",
                "weightsSha256": file_sha(path), "optimizerSha256": optimizer_sha, **metadata}
    manifest["checkpointSha256"] = digest(manifest)
    write_json(root / "manifest.json", manifest)
    return manifest


def load_checkpoint(root):
    root = Path(root)
    manifest = read_json(root / "manifest.json")
    frozen = dict(manifest)
    claimed = frozen.pop("checkpointSha256", None)
    if claimed != digest(frozen) or manifest.get("schema") != "frostecho.jev05.shared-scalar/1":
        raise ValueError("checkpoint identity/hash mismatch")
    path = root / "weights.npy"
    if file_sha(path) != manifest.get("weightsSha256"):
        raise ValueError("checkpoint weight bytes changed")
    weights = np.load(path, allow_pickle=False)
    if weights.shape != (manifest["dimension"],) or not np.isfinite(weights).all():
        raise ValueError("invalid shared head weights")
    return manifest, weights


def score_features(weights, values):
    return normalized(values) @ weights


def train_model(cases, feature_map, output, metadata, *, epochs=30, batch_size=32,
                lr=0.03, weight_decay=0.001, seed=17, device="cpu"):
    """Component callable by unit tests; production CLI qualifies inputs first.

    The function does NOT create a research-ready or execution-ready claim.
    metadata determines provenance; only the CLI binds recomputed qualification.
    """
    if epochs < 1 or batch_size < 1 or not math.isfinite(lr) or lr <= 0 or weight_decay < 0:
        raise ValueError("invalid training configuration")
    train = [case for case in cases.values() if case["split"] == "train"]
    dev = [case for case in cases.values() if case["split"] == "dev"]
    if not train or not dev:
        raise ValueError("train and dev are required")
    features = {key: normalized(value) for key, value in feature_map.items()}
    dimension = next(iter(features.values())).shape[1]
    if any(value.shape[1] != dimension for value in features.values()):
        raise ValueError("encoder feature dimensions drifted")
    rng = np.random.default_rng(seed)
    weights = rng.normal(0, 0.01, dimension).astype(np.float32)
    first, second, step = np.zeros(dimension), np.zeros(dimension), 0
    gpu = device != "cpu"
    torch = optimizer = parameter = None
    if gpu:
        import torch as torch_module
        torch = torch_module
        if not torch.cuda.is_available():
            raise ValueError("CUDA training requested but unavailable")
        torch.manual_seed(seed)
        parameter = torch.nn.Parameter(torch.from_numpy(weights).to(device))
        optimizer = torch.optim.AdamW([parameter], lr=lr, weight_decay=weight_decay)
        tensor_features = {key: torch.from_numpy(value).to(device) for key, value in features.items()}
    history, best, best_manifest = [], float("inf"), None
    started = time.monotonic()
    for epoch in range(epochs):
        order = rng.permutation(len(train))
        epoch_losses = []
        for start in range(0, len(order), batch_size):
            batch = [train[int(index)] for index in order[start:start + batch_size]]
            step += 1
            if gpu:
                losses = []
                for case in batch:
                    logits = tensor_features[case["caseId"]] @ parameter
                    acceptable = torch.tensor(indices_for(case), device=device)
                    losses.append(torch.logsumexp(logits, dim=0) - torch.logsumexp(logits[acceptable], dim=0))
                loss = torch.stack(losses).mean()
                optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_([parameter], 5.0)
                optimizer.step()
                epoch_losses.append(float(loss.detach().cpu()))
                weights = parameter.detach().cpu().numpy().copy()
            else:
                gradient = np.zeros(dimension)
                loss_sum = 0.0
                for case in batch:
                    matrix = features[case["caseId"]]
                    loss, derivative = set_loss_gradient(matrix @ weights, indices_for(case))
                    gradient += matrix.T @ derivative
                    loss_sum += loss
                gradient /= len(batch)
                norm = np.linalg.norm(gradient)
                gradient *= min(1.0, 5.0 / max(norm, 1e-12))
                first = 0.9 * first + 0.1 * gradient
                second = 0.999 * second + 0.001 * gradient * gradient
                update = (first / (1 - 0.9 ** step)) / (np.sqrt(second / (1 - 0.999 ** step)) + 1e-8)
                weights = (weights * (1 - lr * weight_decay) - lr * update).astype(np.float32)
                epoch_losses.append(loss_sum / len(batch))
            if not np.isfinite(weights).all():
                raise ValueError("non-finite training weights")
        result = {"epoch": epoch + 1, "steps": step, "trainSetNll": float(np.mean(epoch_losses)),
                  "dev": evaluate(weights, dev, features), "elapsedSeconds": time.monotonic() - started}
        history.append(result)
        if result["dev"]["setNll"] < best:
            best = result["dev"]["setNll"]
            opt = {"step": np.array(step), "firstMoment": first, "secondMoment": second,
                   "rngStateUtf8": np.frombuffer(__import__("json").dumps(rng.bit_generator.state).encode(), dtype=np.uint8)}
            if gpu:
                state = optimizer.state[parameter]
                opt.update(firstMoment=state["exp_avg"].detach().cpu().numpy(), secondMoment=state["exp_avg_sq"].detach().cpu().numpy())
            best_manifest = save_checkpoint(output, weights, {
                **metadata, "selectedEpoch": epoch + 1, "selection": "dev-set-nll",
                "seed": seed, "config": {"epochs": epochs, "batchSize": batch_size, "lr": lr,
                                         "weightDecay": weight_decay, "device": device},
                "dev": result["dev"], "executionAdmitted": False,
            }, opt)
        write_json(Path(output) / "history.json", history)
    manifest, reloaded = load_checkpoint(output)
    report = {"schema": "frostecho.jev05.train-result/1", "checkpointSha256": manifest["checkpointSha256"],
              "selectedEpoch": manifest["selectedEpoch"], "dev": evaluate(reloaded, dev, features),
              "epochs": epochs, "steps": step, "elapsedSeconds": time.monotonic() - started,
              "weightReloadVerified": True, "executionAdmitted": False}
    write_json(Path(output) / "training.json", report)
    return report
