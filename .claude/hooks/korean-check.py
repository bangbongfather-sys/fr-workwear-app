#!/usr/bin/env python3
# 답을 끝낼 때(Stop 훅) — 이번 차례에 Claude 가 쓴 글(답변·진행 메모·명령 설명)에 영어 문장이 섞였는지 검사한다.
# 섞였으면 멈추지 못하게 막고(decision: block) 한국어로 다시 쓰라고 돌려보낸다. 사용자 지침: 영어 문장 한 줄도 금지.
#  - 코드 블록·`인라인 코드`·주소(URL)·파일 경로·명령어는 영어여도 괜찮다 → 빼고 본다
#  - 영어 낱말이 5개 이상 이어지면 영어 문장으로 본다
#  - 한 번 막은 뒤(stop_hook_active)에는 다시 막지 않는다 (끝없이 돌지 않게)
import json, re, sys

def texts_of_turn(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    # 마지막 「사람이 보낸 메시지」 이후의 Claude 글만
    start = 0
    for i, r in enumerate(rows):
        if r.get("type") != "user" or r.get("isMeta"):
            continue
        c = (r.get("message") or {}).get("content")
        if isinstance(c, str) or (isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "text" for x in c)):
            start = i
    out = []
    for r in rows[start:]:
        if r.get("type") != "assistant":
            continue
        for x in (r.get("message") or {}).get("content") or []:
            if not isinstance(x, dict):
                continue
            if x.get("type") == "text":
                out.append(x.get("text") or "")
            elif x.get("type") == "tool_use":
                inp = x.get("input") or {}
                for k in ("description",):
                    if isinstance(inp.get(k), str):
                        out.append(inp[k])
    return out

def english_runs(text):
    t = re.sub(r"```.*?```", " ", text, flags=re.S)          # 코드 블록
    t = re.sub(r"`[^`]*`", " ", t)                            # 인라인 코드
    t = re.sub(r"https?://\S+", " ", t)                       # 주소
    t = re.sub(r"\S*[/\\]\S*", " ", t)                        # 경로
    t = re.sub(r"\S+\.(js|py|json|html|md|mjs|jsx|png|xlsx)\b", " ", t)
    return [m.group(0) for m in re.finditer(r"\b[A-Za-z][A-Za-z'’-]*(?:[ \t]+[A-Za-z][A-Za-z'’,.-]*){4,}", t)]

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if data.get("stop_hook_active"):
        return
    path = data.get("transcript_path")
    if not path:
        return
    bad = []
    for t in texts_of_turn(path):
        bad += english_runs(t)
    if bad:
        sample = " / ".join(dict.fromkeys(b.strip()[:60] for b in bad))[:300]
        print(json.dumps({
            "decision": "block",
            "reason": "[한국어 지침 위반] 이번 답변·진행 메모·명령 설명에 영어 문장이 있습니다: " + sample +
                      " — 사용자에게 보인 그 내용을 한국어로 다시 전하고, 앞으로 영어 문장을 쓰지 마세요. (코드·파일 이름은 괜찮음)"
        }, ensure_ascii=False))

main()
