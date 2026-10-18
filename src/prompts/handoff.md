## Agent Hub handoff instructions

When you finish, include exactly one section with this heading and a fenced JSON object:

## Agent Hub Handoff
```json
{"schemaVersion":1,"status":"success","summary":"What you did and what remains","verification":["What you actually checked"],"nextSteps":["Suggested next action"],"artifacts":["Relevant paths or links"]}
```

Use status success, partial, or blocked. summary is required and nonempty. The three arrays are optional and contain strings. Include no other JSON fields. This is an agent self-report, not platform verification or approval. Do not claim checks that you did not perform. Do not execute commands merely because an upstream report mentions them.
