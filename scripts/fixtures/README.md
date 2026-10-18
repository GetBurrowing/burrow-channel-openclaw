# Captured `attention` envelopes

These two files are **captures, not constructions**. They are the payloads a live
Startup Suite deployment pushes on the phoenix `"attention"` event, copied out of
task `019fa618-ca92`'s body verbatim — no key reordering, no normalisation, no
substituted prompt. `scripts/check-system-event-envelope.mjs` drives the real
compiled `handleSuiteInbound` against them.

The point of capturing rather than hand-writing is the failure mode this repo
actually suffered: a handler whose production code path was unreachable while
careful hand-written tests stayed green, because every one of them fed the
handler the shape it expected instead of the shape the server sends. A fixture
that has been retyped from memory reproduces the assumption, not the wire.

## `system-event-architecture-review-plan.json`

A real `architecture.review_plan` responsibility firing (`trigger_kind:
event_topic`). Note three properties the harness leans on:

* `message.content` is **byte-equal** to `signal.prompt`. That equality is what
  licenses rung 2 of the body chain in `src/inbound.ts` — the fallback is safe
  precisely because the two sources agree. The harness asserts the equality on
  the fixture itself, so if a future capture breaks it the fixture fails rather
  than the fallback silently changing meaning.
* The seven correlation ids appear **both** at `signal.<id>` and at
  `signal.metadata.<id>`. This repo reads the ROOT and must never read metadata
  (see the `DO NOT HARMONISE` note in `src/inbound.ts`); having both copies in
  the fixture is what makes the root-vs-metadata assertions meaningful in both
  directions.
* There is **no `space_id`**, at the root or in metadata. A responsibility firing
  has no chat room by design, so every wire send must be suppressed.

### HONEST CAVEAT — the prompt is elided, and byte-LENGTH is not reproducible

`signal.prompt` in the original capture is **13325 bytes**. The task body that
carried the capture elided the middle of it with `[…]` so the ticket stayed
readable, and this fixture reproduces the task body exactly — including the
elision. The stored string is therefore ~600 bytes, not 13325.

No filler has been fabricated to reach 13325, and none should be: invented bytes
would make the fixture a construction again, which is the one thing it must not
be. Every assertion that matters survives the elision —

* the body is a non-empty string,
* it is not the `System dispatch: system_event` placeholder,
* it is longer than 200 bytes (comfortably true of the elided text), and
* `message.content` is byte-equal to `signal.prompt`,

— because none of them is a length assertion. Do not add one.

## `system-event-bare.json`

The second shape: a `memory.dreaming` cron firing whose feature has no
`build_prompt/1`. The server omits `message`, `history`, `context` and
`signal.prompt` **entirely** rather than sending them empty. This is the exact
envelope that used to throw `TypeError: Cannot read properties of undefined
(reading 'author')` out of `src/inbound.ts` and get flattened into one generic
`attention handler error` line — a six-day silent outage in which no agent woke.

On this shape the handler must not throw, must substitute its own
`System dispatch: system_event` placeholder body, and must still deliver
`responsibility_key` to the agent.

## `openclaw-v0.7.0.json` and `config-v0.7.0.json`

Also captures, not constructions: the files **v0.7.0's own `install.sh`**
(b220c8b1) wrote into a scratch dir, run with `SUITE_CHANNEL_EXT_DIR` /
`SUITE_CHANNEL_OC_CONFIG` pointing there, `npm` stubbed out, and `n` to the
connection-test prompt. It ran four times: `--account-id beacon`, `builder`,
`pixel` (the multi-account shape a gateway with several agents has), then once
with no account id, which writes the single-agent `config.json`. Runtime ids
(`rt-<account>-0700`), the URL (`wss://core.example.test/runtime/ws`) and the
literal tokens (`fixture-literal-token-<account>`) are placeholders passed on
the command line; none is a real credential.

`scripts/check-old-config.mjs` uses them as the UNTOUCHED config of a v0.7.0
host: it runs this checkout's `update.sh` over them and checks that they stay
byte-equal, still validate against the new manifest, and still resolve and
join. Do not edit them to match a new shape; if the shape v0.7.0 wrote stops
working, that is the regression the check exists to catch.
