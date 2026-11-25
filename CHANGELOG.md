# Changelog

## Unreleased — 2026-11-25

- A PR's Decision room card never shows a brief written before its current decision started; the CEO writes a fresh one instead, so cards don't repeat facts that have since changed.

## Unreleased — 2026-11-23

- A PR reaches the manager only when 5 fixes in a row fail; a fix that passes QA, or the manager's retry, resets the count.
- Merge conflicts stay with the floor: after 5 unsuccessful conflict fixes, the floor lead takes over with a fresh fix budget. Failing checks and business decisions keep their existing escalation paths.
- Managers can answer Decision room cards from Teams with numbered approve, option, retry QA and send-back commands; replies stay in the same thread or direct chat, and close stays in the Decision room.

## Unreleased — 2026-11-22

- Approvals never fail on a merge conflict: an approved PR that conflicts with main goes to a developer first and merges by itself once clean; the Decision room only shows PRs that can merge.
