---
title: "Value estimates for a simple game"
subtitle: "A worked example"
---

## 1. Setup

The agent sees a state $s_t$ at each step $t$ and picks an action $a_t$. After the action, it gets a reward $r_t$ and moves to the next state. The game ends after $T$ steps.

## 2. Value of a state

The value of a state is the expected discounted sum of the rewards that follow it:

$$V(s_t) = \mathbb{E}\Big[\sum_{k=0}^{T-t} \gamma^k\, r_{t+k}\Big], \qquad \gamma = 0.9.$$

We estimate it with a small network $V_\theta$. The training loss is the squared error against the observed return:

$$\mathcal{L}(\theta) = \frac{1}{N} \sum_{n=1}^{N} \big(V_\theta(s_n) - G_n\big)^2$$

## 3. Settings

| Setting | Value | Note |
|---|---|---|
| Learning rate | $10^{-3}$ | Adam |
| Batch size | 64 | |
| Discount $\gamma$ | 0.9 | |

The training runs for 50 epochs.

1. Collect games with a random policy.
1. Fit $V_\theta$ on the returns.
1. Check the fit on held-out games.
