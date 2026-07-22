# Global rules

## Delegate Elixir/mix commands to the `mix-runner` subagent

Whenever an Elixir/mix build or verification command needs to run — `mix test`,
`mix compile`, `mix format`, `mix credo`, `mix dialyzer`, `mix sobelow`,
`mix deps.get`/`deps.compile`, `mix ecto.*` — delegate it to the **mix-runner**
subagent (via the Agent tool) instead of running it yourself with Bash.

mix-runner runs on a cheap model and returns a compact pass/fail summary with only
the relevant failures and warnings, so this conversation never fills up with raw
build/test output. Pass it the exact command and any scope (a specific test
file:line, context, or app). Act on the summary it returns.

Run these directly with Bash only when: mix-runner is unavailable, or you
genuinely need the raw, unfiltered output for something the summary can't capture.

## Delegate Apple/Xcode commands to the `apple-runner` subagent

Whenever an Apple app build or test command needs to run — `xcodebuild`
build/test/archive, `swift build`, `swift test`, `xcrun simctl`, `xctest`,
`pod install`, or `fastlane` lanes for iOS/macOS/iPadOS/watchOS/tvOS — delegate it
to the **apple-runner** subagent (via the Agent tool) instead of running it
yourself with Bash.

apple-runner runs on a cheap model and returns a compact pass/fail summary with
only the relevant compiler errors, test failures, and signing issues, so this
conversation never fills up with raw xcodebuild output. Pass it the exact command
and any scope (`-scheme`, `-destination`, `-only-testing:`, etc.). Act on the
summary it returns.

Run these directly with Bash only when: apple-runner is unavailable, or you
genuinely need the raw, unfiltered output for something the summary can't capture.

## Delegate Jira/GitHub operations to the `tracker-runner` subagent

Whenever data needs to be pulled from or pushed to Jira or GitHub, delegate the
`acli`/`gh` call to the **tracker-runner** subagent (via the Agent tool) instead
of running it yourself with Bash. This covers both reads — a work item/ticket and
its comments, a JQL or issue search, a PR with its description, diff, or review
threads, CI/check status and failing logs, release/repo metadata — and writes:
creating/editing/transitioning/assigning/commenting on work items and issues, and
creating/editing/commenting/reviewing/merging/closing PRs.

tracker-runner runs on a cheap model. You do the thinking: decide what to do and
**author all substantive content** (ticket text, PR descriptions, comment bodies,
resolutions), then hand it the exact operation and that prepared content. It runs
the command, pushes your content verbatim (via `--body-file` for long bodies), and
returns a compact result — key/number, URL, new state — so this conversation never
fills up with raw Jira JSON, comment threads, diffs, or CI logs, and you spend no
tokens on CLI plumbing. It never composes content or decides whether to act on its
own, and it runs irreversible actions (delete, merge, close) only when you
explicitly instruct that exact action. For long bodies, write them to a file and
pass the path, or pass the text inline for it to materialise.

Run `acli`/`gh` directly with Bash only when: tracker-runner is unavailable, or
you genuinely need the raw, unfiltered output for something its summary can't
capture.
