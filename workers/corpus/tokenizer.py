"""Bounded local-pinned text measurement. No transformers, remote code, weights or downloads.

The trusted host invokes Python -I -B, caps time/output, and pins the runtime and files.
This worker returns counts and hashes only. No dataset or manifest is modified.
"""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import socket
import sys


class Refused(Exception):
    pass


def require(condition):
    if not condition:
        raise Refused()


def closed(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys))
    return value


def pairs(items):
    out = {}
    for key, value in items:
        require(key not in out)
        out[key] = value
    return out


def reject_number(_):
    raise Refused()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def blocked(*args, **kwargs):
    raise Refused()


def read_asset(root, name, expected, maximum):
    path = root / name
    require(path.is_file() and not path.is_symlink())
    stat = path.stat()
    require(stat.st_nlink == 1 and 0 < stat.st_size <= maximum)
    data = path.read_bytes()
    require(len(data) == stat.st_size and sha(data) == expected)
    return data


def run():
    raw = sys.stdin.buffer.read(262145)
    require(0 < len(raw) <= 262144)
    request = closed(json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_float=reject_number, parse_constant=reject_number),
                     ['version', 'profile', 'tokenizerProfileDigest', 'rowDigest', 'user', 'assistant'])
    require(request['version'] == 'CorpusTokenizerRequest/0.1')
    p = closed(request['profile'], ['version', 'model', 'revision', 'assetRoot', 'tokenizerSha256', 'templateSha256', 'runtime',
                                    'templatePolicy', 'addSpecialTokens', 'maxInputBytes', 'maxTokens', 'officialPipelineParity'])
    require(p['version'] == 'CorpusTokenizer/0.1' and p['templatePolicy'] == 'SFT_USER_ASSISTANT_NO_THINKING/1')
    require(p['addSpecialTokens'] is False and p['maxInputBytes'] == 65536 and p['maxTokens'] == 65536 and p['officialPipelineParity'] == 'NOT_VALIDATED')
    require(sha(canonical(p)) == request['tokenizerProfileDigest'])
    for field in ['rowDigest', 'tokenizerProfileDigest']:
        require(isinstance(request[field], str) and len(request[field]) == 64 and all(c in '0123456789abcdef' for c in request[field]))
    for field in ['user', 'assistant']:
        require(isinstance(request[field], str) and len(request[field].encode('utf-8')) > 0 and '\0' not in request[field])
    require(sum(len(request[field].encode('utf-8')) for field in ['user', 'assistant']) <= p['maxInputBytes'])
    runtime = closed(p['runtime'], ['python', 'tokenizers', 'jinja2', 'markupsafe'])
    require(platform.python_version() == runtime['python'])
    for name in ['tokenizers', 'jinja2', 'markupsafe']:
        require(importlib.metadata.version(name) == runtime[name])
    root = Path(p['assetRoot'])
    require(root.is_absolute() and root.is_dir() and os.path.normcase(str(root.resolve())) == os.path.normcase(str(root)))
    for directory in [root, *root.parents]:
        require(not directory.is_symlink())
    tokenizer_bytes = read_asset(root, 'tokenizer.json', p['tokenizerSha256'], 33554432)
    template_bytes = read_asset(root, 'chat_template.jinja', p['templateSha256'], 65536)
    # Defense in depth for this CPU-only path. The host's OS policy remains a separate boundary.
    socket.socket.connect = blocked
    socket.create_connection = blocked
    from tokenizers import Tokenizer
    from jinja2 import StrictUndefined
    from jinja2.sandbox import SandboxedEnvironment
    tokenizer = Tokenizer.from_str(tokenizer_bytes.decode('utf-8'))
    require(tokenizer.truncation is None and tokenizer.padding is None)
    env = SandboxedEnvironment(undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)
    env.globals['raise_exception'] = blocked
    template = env.from_string(template_bytes.decode('utf-8'))
    messages = [{'role': 'user', 'content': request['user']}]
    settings = dict(enable_thinking=False, truncate_history_thinking=False, medium_effort=False, tools=[])
    prompt = template.render(messages=messages, add_generation_prompt=True, **settings)
    full = template.render(messages=messages + [{'role': 'assistant', 'content': request['assistant']}], add_generation_prompt=False, **settings)
    require(0 < len(prompt.encode('utf-8')) <= 131072 and 0 < len(full.encode('utf-8')) <= 131072)
    prompt_ids = tokenizer.encode(prompt, add_special_tokens=False).ids
    full_ids = tokenizer.encode(full, add_special_tokens=False).ids
    require(0 < len(prompt_ids) < len(full_ids) <= p['maxTokens'])
    require(full_ids[:len(prompt_ids)] == prompt_ids)
    mask = [0] * len(prompt_ids) + [1] * (len(full_ids) - len(prompt_ids))
    return dict(version='CorpusTokenMeasurement/0.1', status='LOCAL_PINNED_EXACT', rowDigest=request['rowDigest'],
                tokenizerProfileDigest=request['tokenizerProfileDigest'], studentInputTokens=str(len(prompt_ids)),
                studentLossTokens=str(len(full_ids) - len(prompt_ids)), fullTokens=str(len(full_ids)),
                inputIdsDigest=sha(canonical(prompt_ids)), fullIdsDigest=sha(canonical(full_ids)), lossMaskDigest=sha(canonical(mask)),
                lossPolicy='ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR', officialPipelineParity='NOT_VALIDATED', actualTrainerParity='NOT_RUN', trainingReady=False)


if __name__ == '__main__':
    try:
        result = run()
    except Exception:
        # Do not emit paths, payload text, package tracebacks or template snippets.
        print('{"version":"CorpusTokenizerFailure/0.1","code":"CP0_TOKENIZER_REFUSED"}')
        sys.exit(1)
    print(canonical(result))
