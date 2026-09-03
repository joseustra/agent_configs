# Global rules

## IMPORTANT

Never commit directly to main/master.

## Delegate Elixir/mix commands to `mix-runner`

Whenever an Elixir/mix build or verification command needs to run—`mix test`,
`mix compile`, `mix format`, `mix credo`, `mix dialyzer`, `mix sobelow`,
`mix deps.get`/`deps.compile`, or `mix ecto.*`—delegate the exact command and
scope to the `mix-runner` custom agent.

Use its compact pass/fail summary instead of bringing raw build output into the
main thread. Run the command directly only when the custom agent is unavailable
or the raw output is genuinely needed.

## Delegate Apple/Xcode commands to `apple-runner`

Whenever an Apple build or test command needs to run—`xcodebuild` build/test/
archive, `swift build`, `swift test`, `xcrun simctl`, `xctest`, `pod install`,
or a `fastlane` lane—delegate the exact command and scope to the `apple-runner`
custom agent.

Use its compact pass/fail summary instead of bringing raw build output into the
main thread. Run the command directly only when the custom agent is unavailable
or the raw output is genuinely needed.

## Delegate Jira/GitHub operations to `tracker-runner`

Whenever data must be read from or written to Jira or GitHub, delegate the exact
`acli` or `gh` operation to `tracker-runner`.

The main agent must decide what to do and author all substantive content first.
Pass prepared ticket text, pull-request descriptions, comments, and resolutions
verbatim to the runner. Irreversible actions such as delete, merge, or close
require an explicit instruction naming that exact action.

Run `acli` or `gh` directly only when the custom agent is unavailable or raw,
unfiltered output is genuinely needed.

