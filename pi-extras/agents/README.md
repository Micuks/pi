# Bundled subagent definitions

These are copies of the subagent example agents that ship with Pi, with one
deliberate change: the hardcoded `model:` line is removed.

The upstream versions pin `claude-haiku-4-5` / `claude-sonnet-4-5`. Those model
IDs exist under several providers (anthropic, cloudflare-ai-gateway, opencode,
radius), so a subagent fails at startup with "configured in multiple providers
but none are authenticated" unless one of those providers happens to be the one
you use. Omitting `model` makes the subagent inherit the dispatching session's
active model and thinking level, which is what you almost always want.

If you do want a fixed model, add the line back with an explicit provider, e.g.
`model: myflicker/claude-4.5-sonnet`.
