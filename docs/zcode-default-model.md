# ZCode default model (durable)

How Agent Hub / headless ZCode picks a model. **No API keys in this file.**

## Headless has no `--model`

ZCode headless CLI (`zcode.cjs`, e.g. 0.16.9) has **no** `--model` / provider flag. Do not invent CLI flags. Model comes from durable config (below), interactive `/model`, or whatever a resumed session last used.

## Durable default: `~/.zcode/v2/provider_config.json`

Edit **`config.defaultModelSelection`** (not chat UI chrome):

```json
{
  "schemaVersion": 1,
  "config": {
    "defaultModelSelection": {
      "providerId": "account:bigmodel-individual-coding-plan",
      "modelId": "GLM-5.3"
    }
  }
}
```

Only change those two string fields; leave the rest of the file alone. **Never paste API keys** into docs, tickets, chat, or git.

### Preferred default (current)

| Field | Value |
| --- | --- |
| `providerId` | `account:bigmodel-individual-coding-plan` |
| `modelId` | `GLM-5.3` |

### Temporary switch to Stepfun

Typical temp pair (ids may vary slightly on your machine):

| Field | Value |
| --- | --- |
| `providerId` | `new-provider-2` |
| `modelId` | `step-5-preview` |

(`new-provider` is the other Stepfun entry in provider rules; board cards often show `new-provider-2/step-5-preview`.)

### Restore snippet

```bash
# After a temp Stepfun switch, put preferred default back:
python3 - <<'PY'
import json
from pathlib import Path
p = Path.home() / ".zcode/v2/provider_config.json"
data = json.loads(p.read_text())
data.setdefault("config", {})["defaultModelSelection"] = {
    "providerId": "account:bigmodel-individual-coding-plan",
    "modelId": "GLM-5.3",
}
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print("restored:", data["config"]["defaultModelSelection"])
PY
```

## Chat chrome vs durable file

- Changing model in the **chat / TUI chrome** affects **that one session** only (or what `--resume` inherits).
- Editing **`provider_config.json`** is the durable default for **new** headless / new chats.
- After editing the file: **restart ZCode / start a new chat** (and restart the Agent Hub board if you need a fresh process). Old sessions keep their last model until resumed or recreated.

## Related

- Runbook: [DEMO.md](../DEMO.md)
- Dispatch notes (resume + model): [DISPATCH.md](../DISPATCH.md)
