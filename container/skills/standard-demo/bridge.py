#!/usr/bin/env python3
"""
standard-demo bridge
Match user message → QA pair → print structured output for openclaw.

Usage:
    python3 bridge.py "<user_message>"

Stdout:
    TEXT:<answer text (directive lines stripped)>
    IMAGE:<absolute path to image file>   (one per image, in order)
    SAVE:<absolute path to save the answer text>
    FORWARD:<group chat id to forward the text>
    MENTION:<name to @mention in forwarded message>
  — or —
    TEXT:<fallback message>
"""

import sys
import os
import re

SKILL_ROOT = os.path.dirname(os.path.abspath(__file__))
QA_PATH    = os.path.join(SKILL_ROOT, "references", "qa-mapping.md")

FALLBACK = "请发送一个已定义的固定 demo 问题，我会按原样返回对应答案。"


def _key_chars(text):
    """Extract meaningful CJK characters (skip punctuation/spaces)."""
    return set(c for c in text if '\u4e00' <= c <= '\u9fff')


def load_qa_pairs():
    """Parse qa-mapping.md → list of (trigger, answer_text, [images], [saves], [forwards], [mentions])."""
    with open(QA_PATH, encoding="utf-8") as f:
        content = f.read()

    pairs = []
    blocks = re.split(r'\n---+\n', content)

    # Regex for all directive types: standalone backtick lines
    DIRECTIVE_RE = re.compile(
        r'^`((?:assets/[^`]+\.(?:jpg|png))|(?:SAVE:[^`]+)|(?:FORWARD:[^`]+)|(?:MENTION:[^`]+))`[ \t]*$',
        re.MULTILINE
    )

    for block in blocks:
        trigger_m = re.search(r'\*\*Trigger:\*\*\s*`([^`]+)`', block)
        answer_m  = re.search(r'\*\*Answer:\*\*\s*\n([\s\S]+)', block)
        if not trigger_m or not answer_m:
            continue

        trigger    = trigger_m.group(1).strip()
        answer_raw = answer_m.group(1).strip()

        # Collect all directives
        directives = DIRECTIVE_RE.findall(answer_raw)
        abs_images = [os.path.join(SKILL_ROOT, d) for d in directives if d.startswith("assets/")]
        saves      = [d.split(":", 1)[1] for d in directives if d.startswith("SAVE:")]
        forwards   = [d.split(":", 1)[1] for d in directives if d.startswith("FORWARD:")]
        mentions   = [d.split(":", 1)[1] for d in directives if d.startswith("MENTION:")]

        # Strip all directive lines from answer text
        answer_text = DIRECTIVE_RE.sub('', answer_raw).strip()

        pairs.append((trigger, answer_text, abs_images, saves, forwards, mentions))

    return pairs


def match_trigger(user_msg, pairs):
    """Return (answer_text, images, saves, forwards, mentions) for best match, or None."""
    user_msg = user_msg.strip()

    # 1. Exact match
    for trigger, answer, images, saves, forwards, mentions in pairs:
        if trigger == user_msg:
            return answer, images, saves, forwards, mentions

    # 2. Substring match (longest trigger that fits)
    best, best_len = None, 0
    for trigger, answer, images, saves, forwards, mentions in pairs:
        if trigger in user_msg or user_msg in trigger:
            if len(trigger) > best_len:
                best, best_len = (answer, images, saves, forwards, mentions), len(trigger)
    if best:
        return best

    # 3. Key-character overlap: if ≥75% of trigger's CJK chars appear in user_msg
    best, best_score = None, 0.0
    user_chars = _key_chars(user_msg)
    for trigger, answer, images, saves, forwards, mentions in pairs:
        t_chars = _key_chars(trigger)
        if not t_chars:
            continue
        overlap = len(t_chars & user_chars) / len(t_chars)
        if overlap >= 0.75 and overlap > best_score:
            best, best_score = (answer, images, saves, forwards, mentions), overlap
    return best


def main():
    user_msg = " ".join(sys.argv[1:]).strip() if len(sys.argv) > 1 else ""
    if not user_msg:
        print(f"TEXT:{FALLBACK}")
        return

    pairs  = load_qa_pairs()
    result = match_trigger(user_msg, pairs)

    if result is None:
        print(f"TEXT:{FALLBACK}")
        return

    answer_text, image_paths, saves, forwards, mentions = result
    print(f"TEXT:{answer_text}")

    for abs_path in image_paths:
        if os.path.isfile(abs_path):
            print(f"IMAGE:{abs_path}")
        else:
            sys.stderr.write(f"[bridge] not found: {abs_path}\n")

    for save_path in saves:
        abs_save = os.path.join(SKILL_ROOT, save_path) if not os.path.isabs(save_path) else save_path
        print(f"SAVE:{abs_save}")

    for group_id in forwards:
        print(f"FORWARD:{group_id}")

    for name in mentions:
        print(f"MENTION:{name}")


if __name__ == "__main__":
    main()
