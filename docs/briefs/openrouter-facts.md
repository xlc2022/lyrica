# Brief: more of OpenRouter's model list

Serves principle 1 (the user sees what a model costs and when it goes away,
and free models stop failing their first thinking-off call) and the owner's
ask to read more of OpenRouter's public `GET /api/v1/models`, tested with the
free MiniMax model.

## First PR

- **Thinking**: `reasoning.supported_efforts` gives the levels (minimal
  counts as low, xhigh and max as high), and `reasoning.mandatory` marks the
  model `alwaysThinks`, the same fact LM Studio gives, so off becomes
  `mandatoryThinking` before the first request instead of after a refusal
  that counts against free limits.
- **Price**: `pricing` as dollars per million tokens, `free` when input and
  output cost nothing. Shown in the model picker and the text library.
- **Retirement**: `expiration_date` as `retiresAt`, shown beside the price,
  in warn within two weeks.
- **Reply limit**: `top_provider.max_completion_tokens` as `maxOutput`, which
  caps the reply cap.

All of it rides in `offerings.found`, so no migration.

## Next, each its own PR

1. A "free models only" rule per user, and a warning before a turn or task
   would use a paid model, so a retired `:free` model never falls through to
   its paid twin unnoticed.
2. A warning when a model in a task list retires within two weeks.
3. With the key, `GET /api/v1/key`: usage, limit and the free tier's daily
   requests.
4. `per_request_limits`, video and audio input, audio output and voices,
   `alias_target` ("~" aliases), description, knowledge cutoff, Hugging Face
   ID.
