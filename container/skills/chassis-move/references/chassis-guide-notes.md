# Chassis Move Notes

## Guide-derived assumptions

The provided guide states:
- semantic navigation is controlled over MQTT
- send plaintext to the semantic navigation topic
- the payload should be the target point label from `semantic_points.yaml`
- broker host is `x2219abf.ala.cn-hangzhou.emqxsl.cn`
- broker port is `8883`
- username is `emqx`
- publisher client id must be unique (example: `openclaw_pub_001`)
- do not reuse receiver client id `rdk_subscriber`

## Topic clarification

The guide mentions `semantic_nav#` and also says the topic name is `semantic_nav`.

For command publishing, use:
- `semantic_nav`

Why:
- `#` is a subscription wildcard in MQTT
- publishing to a wildcard topic is not the intended control path

## Payload rule

Publish only the target label as plaintext, for example:

```text
door
```

Do not wrap it in JSON unless the backend contract changes.

## Known labels (operator guide 2026-04-27)

| label | meaning |
|---|---|
| `door` | 门前 |
| `lab_table` | 实验桌前 |

This is the authoritative list as of the latest operator-guide revision. Earlier docs used `test1` as an example — that label is **not** in the current `semantic_points.yaml` and should not be published.

## ACK / confirmation

Current publish success only proves the broker accepted the message.
For downstream confirmation, subscribe to:
- `semantic_nav/ack`
- or temporarily `semantic_nav/#` for debugging

Expected ACK example:

```json
{
  "from": "rdk_subscriber",
  "topic": "semantic_nav",
  "label": "lab1",
  "status": "success",
  "detail": "label 已发到 /semantic_nav/label"
}
```

## Failure checks

If publish fails, check in this order:
1. broker reachability
2. username/password correctness
3. TLS availability on port `8883`
4. whether the chassis subscriber is online
5. whether the target label exists in `semantic_points.yaml`
6. whether ACK is arriving on `semantic_nav/ack`

## Safety note

Because this moves a real robot base, require an explicit user intent to move before publishing a label.
