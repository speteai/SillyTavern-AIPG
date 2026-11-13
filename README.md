# AI Power Grid for SillyTavern

Community-built, not an official AI Power Grid or SillyTavern project.

[AI Power Grid](https://aipowergrid.io) is a network of independent GPU operators behind one OpenAI-compatible
API. You pay per use from a prepaid balance or a daily free allowance.

- **Chat needs no extension.** SillyTavern's own *Custom (OpenAI-compatible)* source works with the grid. The
  [setup guide](#chat-setup-guide) below lists the settings that matter.
- **Images need this extension.** SillyTavern's image generation extension has no source that can be pointed at
  the grid, so this extension adds one: a slash command, a wand-menu entry and an optional tool for the chat model.

Tested with SillyTavern 1.19.0 (release branch) against the live grid on 2026-11-13.

## Image extension

### Install

In SillyTavern open **Extensions → Install extension** and enter

```
https://github.com/speteai/SillyTavern-AIPG
```

Then open **Extensions → AI Power Grid images**, paste an API key from the
[AIPG Console](https://console.aipowergrid.io/?callbackUrl=%2Fdashboard%2Fapi-key) (it starts with `grid_`) and
pick a model. The list shows the image models that are online, with their list price.

### Use

| Way | How |
| --- | --- |
| Slash command | `/aipg a harbour town at dawn, oil painting` |
| With options | `/aipg size=1344x768 model=z-image-turbo a harbour town at dawn` |
| Wand menu | **AI Power Grid image**, then type the description |
| By the chat model | Switch on *Let the chat model generate images by itself*. The model then gets a tool `aipg_generate_image`. This needs a chat model and connection with function calling. |

The image is saved in SillyTavern's image folder and added to the chat as a message. `/aipg` returns the saved
path, so it can be used in a script. `/aipg-image` is an alias.

Sizes: 1024x1024, 1344x768, 768x1344, 1216x832, 832x1216.

**Check credit** shows what the account can spend, including today's free allowance.

### Cost

At the time of the test an image cost between $0.003 (`z-image-turbo`) and $0.01, and took about 10 seconds.
Models and prices change with the operators who are online.

### Good to know

- The API key is stored in SillyTavern's settings in plain text, like other extension settings. Anyone who can
  read your SillyTavern data folder can read it.
- The extension talks to `api.aipowergrid.io` directly from your browser. It downloads images only from the
  grid's own storage (`*.aipg.art`, `*.aipowergrid.io`).
- Your image description is processed in plain text on a computer run by an independent operator. Keep private
  details out of it.
- One image at a time. A second request while one is running is refused with a notice.
- If the selected model has gone offline, the list marks it and the request fails with the grid's message.

## Chat setup guide

1. Create an API key in the [AIPG Console](https://console.aipowergrid.io/?callbackUrl=%2Fdashboard%2Fapi-key).
2. In SillyTavern open **API Connections**, set **API** to *Chat Completion* and **Chat Completion Source** to
   *Custom (OpenAI-compatible)*.
3. **Custom Endpoint (Base URL):** `https://api.aipowergrid.io/v1` (with `/v1`, without `/chat/completions`).
4. **Custom API Key:** your key.
5. Press **Connect**. The model list is filled from the grid. Pick a model.
6. Set **Prompt Post-Processing** to *Semi-strict* (see below; without it some models refuse the request).

### Settings that matter

| Setting | Use | Why |
| --- | --- | --- |
| Prompt Post-Processing | *Semi-strict* or *Strict* | `qwen38-flash-next-nvfp4` answers HTTP 400 when a system message comes after the first message, which SillyTavern does for author's notes and world info. With *None* or *Merge* the request failed; with *Semi-strict*, *Strict* and *Single user message* it worked. `gpt-oss-120b` accepted every mode. |
| Max Response Length | 1024 or more | The models think before they answer. With a small budget the thinking can use it all and the answer comes back empty, but is still billed. |
| Multiple swipes per generation (`n`) | 1 | With `n: 2` the grid returned one answer in which the two completions were mixed into each other. |
| Logit Bias | leave empty | Any logit bias made `qwen38-flash-next-nvfp4` fail with HTTP 502. `gpt-oss-120b` accepted it. |
| Streaming | on | Works. It also avoids the grid's 120-second limit on a request that sends nothing back. |

### What works

Tested on the two text models that were online, `qwen38-flash-next-nvfp4` and `gpt-oss-120b`.

| Feature | `qwen38-flash-next-nvfp4` | `gpt-oss-120b` |
| --- | --- | --- |
| Model discovery (Connect fills the list) | yes | yes |
| Chat, several turns, staying in character | yes | yes |
| Streaming | yes, first text after about 1 s | yes, first text after about 5 s |
| Reasoning shown separately (`reasoning_content`) | yes | yes |
| Tool calling (function calling) | yes | yes |
| Image input (inline image) | yes | no (the model says it cannot see images) |
| Structured output (JSON schema) | yes | not tested |
| Stop strings, seed, top P, frequency and presence penalty, logprobs | accepted | not tested |
| Continue from a prefilled assistant message | accepted, but the model starts a new sentence instead of continuing | not tested |
| `auto` as the model (the grid picks one) | routed to `gpt-oss-120b` in the test | |

Reasoning effort: SillyTavern does not forward its reasoning-effort setting to a custom endpoint. To send one,
add `reasoning_effort: low` under **Additional Parameters → Include Body Parameters**.

Token counts: SillyTavern estimates tokens with its own tokenizer; the grid bills its own count.

### Cost

List prices at the time of the test: $0.075 per million input tokens, $0.30 per million output tokens. A
role-play reply of a few sentences cost between $0.00003 and $0.0001.

### Limits

- 30 chat requests per minute per account.
- A request may hold at most 200,000 characters. Long chats with a large context setting can reach this; lower
  **Context Size** if you get HTTP 413.
- Models come and go with the operators. If the list is empty or a model is missing, it is offline.
- An unknown model or a base URL without `/v1` shows up in SillyTavern only as "Not Found".

### Privacy

Everything SillyTavern sends, including your character cards, chat history and persona, is processed in plain
text on a computer run by an independent operator. Do not use it for content that must stay private.

## Support

Issues with the extension or this guide: https://github.com/speteai/SillyTavern-AIPG/issues. For the grid
itself: https://aipowergrid.io/docs.

## License

MIT
