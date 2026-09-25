"""Split a script into sentences with the pause after each one.

A small mirror of `splitScript` in ../../videocompressor/voice.js, for speaking
a script from the command line with the same shape of request the page sends.
"""
import re

_ABBREV = re.compile(r"\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Fig|No|approx)\.$", re.I)


def split_sentences(para: str) -> list[str]:
    out, start = [], 0
    for m in re.finditer(r"[.?!]+[\"')\]”’]*\s+(?=[A-Z0-9\"“(])", para):
        chunk = para[start:m.end()].strip()
        if _ABBREV.search(chunk) or re.search(r"\b[A-Z]\.$", chunk):
            continue  # "e.g. The" or an initial, not a sentence end
        out.append(chunk)
        start = m.end()
    tail = para[start:].strip()
    if tail:
        out.append(tail)
    return out


def split_script(text: str, sentence=0.36, paragraph=0.78, clause=0.2) -> list[dict]:
    paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n+", text or "")]
    paras = [p for p in paras if p]
    parts = []
    for pi, para in enumerate(paras):
        ss = split_sentences(para)
        for si, s in enumerate(ss):
            last_here = si == len(ss) - 1
            last_all = last_here and pi == len(paras) - 1
            if last_all:
                kind, pause = "end", 0.0
            elif last_here:
                kind, pause = "paragraph", paragraph
            elif re.search(r"[,;:][\"')\]”’]*$", s):
                kind, pause = "clause", clause
            else:
                kind, pause = "sentence", sentence
            parts.append({"text": s, "pauseAfterS": pause, "kind": kind, "paragraph": pi})
    return parts


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(split_script(sys.stdin.read()), indent=1))
