"""Bounded batch measurement; assets loaded once for at most 32 rows. No transformers, remote code, weights or downloads.

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

stage = 'REQUEST_READ'


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
    global stage
    stage = 'REQUEST_READ'
    raw = sys.stdin.buffer.read(2097153)
    require(0 < len(raw) <= 2097152)
    stage = 'REQUEST_PARSE'
    request = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_float=reject_number, parse_constant=reject_number)
    stage = 'REQUEST_SCHEMA'
    closed(request, ['version', 'profile', 'tokenizerProfileDigest', 'items'])
    require(request['version'] == 'CorpusProductionTokenizerBatchRequest/0.1')
    p = closed(request['profile'], ['version', 'model', 'revision', 'assetRoot', 'tokenizerSha256', 'templateSha256', 'runtime',
                                    'templatePolicy', 'addSpecialTokens', 'maxInputBytes', 'maxTokens', 'officialPipelineParity'])
    require(p['version'] == 'CorpusTokenizer/0.1' and p['templatePolicy'] == 'SFT_USER_ASSISTANT_NO_THINKING/1')
    require(p['addSpecialTokens'] is False and p['maxInputBytes'] == 65536 and p['maxTokens'] == 65536 and p['officialPipelineParity'] == 'NOT_VALIDATED')
    stage = 'PROFILE_BINDING'
    require(sha(canonical(p)) == request['tokenizerProfileDigest'])
    require(isinstance(request['items'], list) and 0 < len(request['items']) <= 32)
    seen = set()
    for item in request['items']:
        closed(item, ['rowDigest', 'user', 'assistant'])
        require(isinstance(item['rowDigest'], str) and len(item['rowDigest']) == 64 and all(c in '0123456789abcdef' for c in item['rowDigest']))
        require(item['rowDigest'] not in seen)
        seen.add(item['rowDigest'])
        for field in ['user', 'assistant']:
            require(isinstance(item[field], str) and len(item[field].encode('utf-8')) > 0 and '\0' not in item[field])
        require(sum(len(item[field].encode('utf-8')) for field in ['user', 'assistant']) <= p['maxInputBytes'])
    stage = 'RUNTIME_VERSION'
    runtime = closed(p['runtime'], ['python', 'tokenizers', 'jinja2', 'markupsafe'])
    require(platform.python_version() == runtime['python'])
    for name in ['tokenizers', 'jinja2', 'markupsafe']:
        require(importlib.metadata.version(name) == runtime[name])
    stage = 'ROOT_CANONICALITY'
    root = Path(p['assetRoot'])
    require(root.is_absolute() and root.is_dir() and os.path.normcase(str(root.resolve())) == os.path.normcase(str(root)))
    stage = 'ROOT_SYMLINK'
    for directory in [root, *root.parents]:
        require(not directory.is_symlink())
    stage = 'TOKENIZER_ASSET'
    tokenizer_bytes = read_asset(root, 'tokenizer.json', p['tokenizerSha256'], 33554432)
    stage = 'TEMPLATE_ASSET'
    template_bytes = read_asset(root, 'chat_template.jinja', p['templateSha256'], 65536)
    # Defense in depth for this CPU-only path. The host's OS policy remains a separate boundary.
    socket.socket.connect = blocked
    socket.create_connection = blocked
    stage = 'IMPORT_TOKENIZERS'
    from tokenizers import Tokenizer
    stage = 'IMPORT_TEMPLATE'
    from jinja2 import StrictUndefined
    from jinja2.sandbox import SandboxedEnvironment
    stage = 'LOAD_TOKENIZER'
    tokenizer = Tokenizer.from_str(tokenizer_bytes.decode('utf-8'))
    stage = 'TOKENIZER_SETTINGS'
    require(tokenizer.truncation is None and tokenizer.padding is None)
    stage = 'COMPILE_TEMPLATE'
    env = SandboxedEnvironment(undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)
    env.globals['raise_exception'] = blocked
    template = env.from_string(template_bytes.decode('utf-8'))
    results = []
    for item in request['items']:
        messages = [{'role': 'user', 'content': item['user']}]
        settings = dict(enable_thinking=False, truncate_history_thinking=False, medium_effort=False, tools=[])
        stage = 'RENDER_PROMPT'
        prompt = template.render(messages=messages, add_generation_prompt=True, **settings)
        stage = 'RENDER_FULL'
        full = template.render(messages=messages + [{'role': 'assistant', 'content': item['assistant']}], add_generation_prompt=False, **settings)
        stage = 'RENDER_BOUNDS'
        require(0 < len(prompt.encode('utf-8')) <= 131072 and 0 < len(full.encode('utf-8')) <= 131072)
        stage = 'ENCODE_PROMPT'
        prompt_ids = tokenizer.encode(prompt, add_special_tokens=False).ids
        stage = 'ENCODE_FULL'
        full_ids = tokenizer.encode(full, add_special_tokens=False).ids
        stage = 'TOKEN_BOUNDS'
        require(0 < len(prompt_ids) < len(full_ids) <= p['maxTokens'])
        stage = 'PREFIX_MATCH'
        require(full_ids[:len(prompt_ids)] == prompt_ids)
        stage = 'RESULT'
        mask = [0] * len(prompt_ids) + [1] * (len(full_ids) - len(prompt_ids))
        results.append(dict(version='CorpusTokenMeasurement/0.1', status='LOCAL_PINNED_EXACT', rowDigest=item['rowDigest'],
                    tokenizerProfileDigest=request['tokenizerProfileDigest'], studentInputTokens=str(len(prompt_ids)),
                    studentLossTokens=str(len(full_ids) - len(prompt_ids)), fullTokens=str(len(full_ids)),
                    inputIdsDigest=sha(canonical(prompt_ids)), fullIdsDigest=sha(canonical(full_ids)), lossMaskDigest=sha(canonical(mask)),
                    lossPolicy='ASSISTANT_SUFFIX_WITH_TEMPLATE_TERMINATOR', officialPipelineParity='NOT_VALIDATED', actualTrainerParity='NOT_RUN', trainingReady=False))
    return dict(version='CorpusProductionTokenizerBatchResult/0.1', tokenizerProfileDigest=request['tokenizerProfileDigest'], measurements=results)



if __name__ == '__main__':
    try:
        result = run()
    except Exception as error:
        # Do not emit paths, payload text, package tracebacks or template snippets.
        code = ('VALIDATION_REJECTED' if isinstance(error, Refused) else
                'PACKAGE_NOT_FOUND' if isinstance(error, importlib.metadata.PackageNotFoundError) else
                'FILE_NOT_FOUND' if isinstance(error, FileNotFoundError) else
                'ACCESS_DENIED' if isinstance(error, PermissionError) else
                'UNICODE_ERROR' if isinstance(error, UnicodeError) else
                'IMPORT_ERROR' if isinstance(error, ImportError) else
                'OS_ERROR' if isinstance(error, OSError) else 'UNKNOWN')
        print(canonical(dict(version='CorpusTokenizerFailure/0.2', stage=stage, code=code)))
        sys.exit(1)
    print(canonical(result))
