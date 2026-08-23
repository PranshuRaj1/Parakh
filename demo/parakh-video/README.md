# Parakh Demo PR

This folder contains small, self-contained examples for recording the Parakh product video.

## Hero PR

`webhook-review.ts` contains a deliberately unsafe check-then-set flow. Two concurrent webhook deliveries can both observe that a review is not active and both start processing it.

Suggested PR title:

`Prevent duplicate review processing during concurrent webhook deliveries`

Suggested PR description:

```md
## What changed

Added webhook review processing for pull request events.

## Why

The worker needs to prevent two webhook deliveries from processing the same pull request at the same time.

## Testing

- Tested a normal pull request event
- Tested repeated webhook delivery
- Confirmed the review is posted to GitHub
```

## Learning PR

`payment-capture.ts` contains retry handling that should be rejected by the repository's payment rule.

Suggested PR title:

`Add retry handling to payment capture`

Suggested PR description:

```md
## What changed

Added automatic retry handling for temporary payment API failures.

## Why

Retries should make payment requests more resilient.
```

After Parakh comments on the retry, reply with:

```text
Payment capture must never be automatically retried because the upstream operation is not idempotent.

Please remember this rule for future reviews.
```

Then create a second PR with the same pattern and record that Parakh no longer raises the warning.
