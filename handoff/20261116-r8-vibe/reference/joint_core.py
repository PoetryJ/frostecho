"""NumPy reference only: dynamic joint candidate readout, not a real model run.

Production must use actual tokenizer/backbone features and differentiable Torch
operations. Feasibility/permissions belong to the authoritative upstream filter.
K=0/1 use explicit unavailable/deterministic paths, not invented alternatives.
Causal endpoints see earlier candidates, not later ones: preserve this old-C
readout mechanism, rerender/reencode permutations, never claim invariance.
This action renderer is a new protocol; old priority-task calibration cannot transfer.
"""
import json
import numpy as np


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def joint_prompt(context, candidates, order=None):
    if not 2 <= len(candidates) <= 8:
        raise ValueError("joint scorer supports K=2..8")
    ids = [item.get("id") for item in candidates]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("candidate IDs must be unique nonempty strings")
    order = list(ids if order is None else order)
    if len(order) != len(ids) or set(order) != set(ids):
        raise ValueError("order must be a permutation of the actual IDs")
    if not isinstance(context, (str, dict)):
        raise ValueError("context must be text or an observed-context object")
    context = context if isinstance(context, str) else canonical(context)
    content = "Observed context and current goals:\n" + context + "\nCandidate actions:\n"
    lookup, ranges = dict(zip(ids, candidates)), []
    for index, candidate_id in enumerate(order):
        item = lookup[candidate_id]
        if item.get("feasible") is False:
            raise ValueError("explicitly infeasible candidate must be filtered upstream")
        if any(not isinstance(item.get(k), str) or not item[k] for k in ("description", "action")):
            raise ValueError("candidate needs description and action")
        if not isinstance(item.get("params"), dict):
            raise ValueError("candidate params must be an object")
        # Opaque IDs, reference utility, labels and rollout outcomes never enter text.
        visible_preconditions = item.get("preconditions", [])
        if not isinstance(visible_preconditions, list) or any(
                not isinstance(p, str) for p in visible_preconditions):
            raise ValueError("preconditions must be a list of actor-visible descriptions")
        semantics = {k: item[k] for k in ("description", "action", "params")}
        semantics["preconditions"] = visible_preconditions
        line = chr(65 + index) + ". " + canonical(semantics)
        start = len(content)
        content += line
        ranges.append((start, len(content)))
        content += "\n"
    content += "Choose the next action using only observed evidence and current goals."
    return {"content": content, "candidate_ids": order, "candidate_char_ranges": ranges}


def render_joint(tokenizer, context, candidates, *, order=None, max_tokens=4096):
    built = joint_prompt(context, candidates, order)
    content = built["content"]
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": content}], tokenize=False,
        add_generation_prompt=True, enable_thinking=False)
    # Locate the whole assembled message, never player-supplied candidate markers.
    offset = rendered.find(content)
    if offset < 0 or rendered.find(content, offset + 1) >= 0:
        raise ValueError("chat template must preserve one complete assembled message")
    tokens = tokenizer(rendered, add_special_tokens=False, truncation=False,
                       return_offsets_mapping=True)
    ids, offsets = tokens["input_ids"], tokens["offset_mapping"]
    if not isinstance(max_tokens, int) or max_tokens < 1 or len(ids) > max_tokens:
        raise ValueError("input exceeds token budget; no truncation")
    if len(ids) != len(offsets):
        raise ValueError("token/offset count mismatch")
    positions = []
    for _begin, end in built["candidate_char_ranges"]:
        character = offset + end - 1
        matches = [i for i, (a, b) in enumerate(offsets) if a <= character < b]
        if len(matches) != 1:
            raise ValueError("candidate end must map to exactly one token")
        positions.append(matches[0])
    if len(set(positions)) != len(candidates):
        raise ValueError("candidate readout positions are not distinct")
    return {**built, "rendered": rendered, "token_ids": ids, "positions": positions}


def finite_array(value, ndim):
    array = np.asarray(value, dtype=np.float64)
    if array.ndim != ndim or not np.isfinite(array).all():
        raise ValueError("expected finite numeric array with the specified rank")
    return array


def score_joint(candidate_hidden, weight):
    """z_i = w^T LN(h_i), population variance, eps=1e-5, no bias."""
    hidden = finite_array(candidate_hidden, 2)
    weight = finite_array(weight, 1)
    if not 2 <= hidden.shape[0] <= 8 or hidden.shape[1] != len(weight) or not len(weight):
        raise ValueError("expected [K,D] features and a shared [D] weight")
    with np.errstate(over="ignore", invalid="ignore"):
        centered = hidden - hidden.mean(axis=-1, keepdims=True)
        variance = (centered ** 2).mean(axis=-1, keepdims=True)
    if not np.isfinite(variance).all():
        raise ValueError("variance exceeded numeric range")
    with np.errstate(over="ignore", invalid="ignore"):
        normalized = centered / np.sqrt(variance + 1e-5)
        result = normalized @ weight
    if not np.isfinite(normalized).all() or not np.isfinite(result).all():
        raise ValueError("normalization/scoring exceeded numeric range")
    return result


def shifted_logits(logits, temperature):
    logits = finite_array(logits, 1)
    if not 2 <= len(logits) <= 8 or not np.isfinite(temperature) or temperature <= 0:
        raise ValueError("require K=2..8 and positive finite temperature")
    with np.errstate(over="ignore"):
        return (logits - logits.max()) / temperature


def softmax(logits, temperature=1.0):
    exponentials = np.exp(shifted_logits(logits, temperature))
    return exponentials / exponentials.sum()


def acceptable_set_loss(logits, acceptable_indices, temperature=1.0):
    """-log sum_{i in acceptable} softmax(z/T)_i; not mean single-label CE."""
    shifted = shifted_logits(logits, temperature)
    accepted = list(acceptable_indices)
    if (not accepted or any(type(i) is not int or i < 0 or i >= len(shifted) for i in accepted)
            or len(set(accepted)) != len(accepted)):
        raise ValueError("acceptable indices must be a nonempty unique in-range set")
    good = shifted[accepted]
    peak = good.max()
    if not np.isfinite(peak):
        raise ValueError("acceptable-set loss exceeds numeric range")
    loss = np.log(np.exp(shifted).sum()) - peak - np.log(np.exp(good - peak).sum())
    if not np.isfinite(loss):
        raise ValueError("non-finite loss")
    return float(loss)
