# Review finding classes

The class slugs that review records and `docs/review.md` use in this repository.

- `failure-counted-as-success`: An error, failed, missing or ungraded result is not detected and is counted as a successful or completed one. First seen 2026-11-25.
- `stale-behavior-claim-in-docs`: A document or code comment still states behavior that the change altered, or states a rule more broadly than the code applies it. First seen 2026-11-26.
- `weak-test-oracle`: A test oracle checks only part of the output, so a mutated or wrong result still passes. First seen 2026-11-25.
