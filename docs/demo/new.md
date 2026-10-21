---
title: "Value estimates for a simple game"
subtitle: "A worked example with a target network"
---

## 1. Setup

The agent sees a state $s_t$ at each step $t$ and picks an action $a_t$ from a fixed set $\mathcal{A}$. After the action, it gets a reward $r_{t+1}$ and moves to the next state. The game ends after $T$ steps, or earlier when the agent loses.

## 2. Value of a state

The value of a state is the expected discounted sum of the rewards that follow it:

$$V(s_t) = \mathbb{E}\Big[\sum_{k=0}^{T-t-1} \gamma^k\, r_{t+k+1}\Big], \qquad \gamma = 0.99.$$

We estimate it with a small network $V_\theta$ and a slow copy $V_{\bar\theta}$ of it. The training loss is the squared error against a one-step target, plus a weight penalty:

$$\mathcal{L}(\theta) = \frac{1}{N} \sum_{n=1}^{N} \big(V_\theta(s_n) - r_{n+1} - \gamma\, V_{\bar\theta}(s_{n+1})\big)^2 + \lambda \lVert \theta \rVert^2$$

## 3. Settings

| Setting | Value | Note |
|---|---|---|
| Learning rate | $3 \times 10^{-4}$ | Adam |
| Batch size | 256 | |
| Discount $\gamma$ | 0.99 | |
| Target update | every 1000 steps | copy $\theta$ to $\bar\theta$ |

The training runs for 200 epochs.

1. Collect games with a random policy.
1. Fit $V_\theta$ on the one-step targets.
1. Copy $\theta$ to $\bar\theta$ at each target update.
1. Check the fit on held-out games.
