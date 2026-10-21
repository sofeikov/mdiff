# Formula changes

A changed denominator:

$$\hat p = \frac{\exp(z_k)}{\sum_j \exp(z_j)}$$

An added regularisation term:

$$\mathcal{L} = \sum_n \big(y_n - \hat y_n\big)^2$$

A changed discount and a changed superscript:

$$V^H_t = \nu_t\,p_t + \gamma\,(1 - p_t)\,V^H_{t+1}, \qquad \gamma = 0.99.$$

A changed argument inside `\left( \right)`:

$$\operatorname{Attn}(Q, K, V) = \operatorname{softmax}\left(\frac{Q K^\top}{\sqrt{d_k}}\right) V$$

A changed set index:

$$s_t = \Big(\ \{ c_i(t) \}_{i \in \mathcal{P}_t},\ u(t)\ \Big)$$

Inline: the window is $W_t = (f_t - L + 1, \dots, f_t)$ with $L = 20$ frames.
