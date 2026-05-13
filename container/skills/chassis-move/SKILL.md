---
name: chassis-move
description: Move the lab chassis robot by publishing a semantic point label over MQTT. Use when the user asks the chassis/base to move, navigate, go to a named point, or drive to a semantic location defined in semantic_points.yaml, especially when the command should be sent through the MQTT semantic navigation topic on the lab network.
---

# Chassis Move

Use this skill for **semantic navigation of the chassis robot**.

## What this skill does

- Accept a destination label from the user
- Validate that the request is a plain semantic point name
- Publish that label as plaintext to the MQTT topic `semantic_nav`
- Report whether the MQTT publish succeeded
- Make clear that publish success is not the same as robot arrival; `semantic_nav/ack` is the first execution-side confirmation topic

## Safety rules

1. Treat chassis movement as a **real-world action**.
2. Do not publish a motion command unless the user is explicitly asking to move the chassis.
3. Do not guess point names.
4. If the label is ambiguous or not provided, ask for the exact target label from `semantic_points.yaml`.
5. The guide text mentions `semantic_nav#`, but `#` is an MQTT wildcard used for subscription. For publishing motion commands, use **`semantic_nav`**.

## Connection settings from the provided guide

- Broker: `x2219abf.ala.cn-hangzhou.emqxsl.cn`
- Port: `8883`
- Username: `emqx`
- Password (per guide): `12345678`
- Topic: `semantic_nav`
- Client ID: use a **unique publisher ID** such as `openclaw_pub_001`; do **not** reuse `rdk_subscriber`

If these credentials change, update the bundled script before execution.

## Known target points (per operator guide, 2026-04-27)

The operator guide currently advertises these labels as valid `semantic_points.yaml` entries:

| label | location |
|---|---|
| `door` | 门前 |
| `lab_table` | 实验桌前 |

Treat this list as **authoritative until the user supplies a newer one**. If the user asks for a Chinese name (e.g. "去门前", "去实验桌"), map to the corresponding label above. If the user asks for any other destination, do **not** guess — ask for the exact label or confirm the YAML has been updated.

## Default workflow

### 1. Parse the destination label

The user should provide the semantic point label directly or in natural language, for example:
- `去 door` / `去门前` → label `door`
- `导航到 lab_table` / `去实验桌前` → label `lab_table`
- `让底盘去 door` → label `door`

Extract only the final semantic point label. Do not publish extra prose.

### 2. Validate before publish

- Confirm the label is not an MQTT topic string
- Reject labels containing `#` or `+`
- If uncertain, ask the user for the exact point name

### 3. Publish with the bundled script

This skill ships its own `.venv/` so `paho-mqtt` does not need to live on the system Python. Always invoke through the bundled interpreter:

```bash
{baseDir}/.venv/bin/python3 {baseDir}/scripts/publish_semantic_nav.py <label>
```

For a non-destructive validation run, use:

```bash
{baseDir}/.venv/bin/python3 {baseDir}/scripts/publish_semantic_nav.py <label> --dry-run
```

If the venv is missing (fresh install or wiped), recreate it:

```bash
python3 -m venv {baseDir}/.venv
{baseDir}/.venv/bin/pip install -r {baseDir}/requirements.txt
```

### 4. Report outcome

If publish succeeds, reply briefly with:
- target label
- MQTT topic used
- whether publish succeeded

If publish fails, include:
- broker
- topic
- exact error
- the next likely check (credentials, broker reachability, topic, or robot subscriber state)

## Bundled resources

### scripts/publish_semantic_nav.py
Deterministic MQTT publisher for semantic navigation labels. The script's shebang points at `{baseDir}/.venv/bin/python3`, so it can also be executed directly if the file is marked executable.

### requirements.txt
Pinned dependency list for the bundled venv (`paho-mqtt`).

### .venv/
Per-skill virtualenv. Do not check into git; recreate from `requirements.txt`.

### references/chassis-guide-notes.md
Read for protocol assumptions, topic clarification, and operator notes.
