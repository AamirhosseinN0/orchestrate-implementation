# Say it plainly

The user is deciding, not reviewing code. A question they have to decode is a
question they answer badly. Reach for the right-hand column.

## Instead of the word, say what it does

| Don't say | Say |
|---|---|
| algorithm, implementation | method, way of working it out |
| schema, migration | the shape of what we store, changing that shape |
| endpoint, API, route | the thing the app calls |
| idempotent | safe to run twice |
| authentication / authorisation | proving who you are / what you are allowed to do |
| permission model, RBAC | who is allowed to do what |
| cache invalidation | knowing when the saved copy has gone stale |
| backfill | going back over what is already stored |
| latency, throughput | how long it takes, how much it gets through |
| serialise, marshal | write it out in a form that can be sent |
| deterministic | the same input always gives the same answer |
| eventual consistency | the phone and the server agree, but not straight away |
| parameterised, configurable | a number somebody has to pick |
| retention policy | how long we keep it before deleting it |
| rate limit, throttle | how often somebody may do it before we say no |
| optimistic locking | what happens when two people change it at once |
| denormalise | keep a second copy so reading is fast |
| polymorphic | one column that points at more than one kind of thing |
| audit trail | the record of who did what |
| soft delete | hidden but still there |
| sharding, partitioning | splitting the data across more than one place |
| schema-on-read | working out the shape when we read it, not when we write it |

## Name a method by what it does, not what it is called

The point is that the user chooses between real things without needing to know
the field. Give the plain description; the real name goes in the written record.

| Real name | How to put it |
|---|---|
| FSRS, SM-17 | a memory model — how hard this card is for you, how long it holds |
| SM-2 | the classic multiply-the-gap rule |
| Leitner | boxes on a shelf |
| Elo, Glicko | a running rating, like a chess rating |
| item response theory | working out how hard a question really is from how people do on it |
| Bayesian knowledge tracing | a running guess at whether they have got it yet |
| CRDT | two copies that can both be edited and still agree afterwards |
| operational transform | replaying edits in an order everyone agrees on |
| exponential backoff | waiting longer each time before trying again |
| bloom filter | a fast, cheap "definitely not" check |
| token bucket | letting somebody save up a few goes and spend them in a burst |
| write-ahead log | writing down what you are about to do before doing it |

## Questions

- One decision per question. If it needs "and", it is two questions.
- Under 28 words, ending in a question mark.
- No file names, no paths, no backticks. The quote from the plan is evidence
  for you, not for them.
- Say the finding in plain words instead: not *"line 7 of the plan says"* but
  *"the plan asks for a known method but does not say which"*.

## Answers

Every answer carries all three:

```
label     under 6 words, plain
✓ gain    what you get. Concrete, not "better".
✕ cost    what it costs. Never "slightly more complex" — say what breaks,
          who notices, and when.
```

- Exactly one recommended, listed first, with `(Recommended)` on the label.
- The recommendation follows from the plan and from what is already built —
  say which when it is not obvious.
- A cost of "none" means the option is not real. Cut it or find the true cost.
- Costs are what actually happens: *"after a holiday a student opens the app to
  nine hundred cards and stops using it"* — not *"may impact engagement"*.
