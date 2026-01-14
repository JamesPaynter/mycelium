# Lessons learned

- Compliance checks are easier to trust when they rely on git diffs against the integration branch instead of ad-hoc file watching.
- Emitting structured access.requested events plus a JSON report keeps rescope/debugging work localized to the per-task logs directory.
