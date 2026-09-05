#!/usr/bin/env python3
"""Surgical asar rewriter for the Claude Desktop context-badge patch.

Rewrites exactly one entry (/.vite/build/mainView.js) and copies every other
entry byte-for-byte, preserving all header flags -- including the three
`unpacked` entries whose payloads live outside the archive in
app.asar.unpacked/. A generic `asar pack` would need matching --unpack-dir
patterns to reproduce those flags; getting them wrong silently breaks the app.

Every entry carries SHA256 integrity metadata. This recomputes it correctly for
the file it changes, so the integrity check stays valid. Nothing is disabled.
"""
import argparse, hashlib, json, struct, sys

TARGET = '/.vite/build/mainView.js'
MARKER = '>>> ctx-badge v1 >>>'


def read_asar(path):
    f = open(path, 'rb')
    head = f.read(8)
    if len(head) < 8 or struct.unpack('<I', head[0:4])[0] != 4:
        raise SystemExit(f'not an asar archive: {path}')
    header_size = struct.unpack('<I', head[4:8])[0]
    hb = f.read(header_size)
    json_len = struct.unpack('<I', hb[4:8])[0]
    header = json.loads(hb[8:8 + json_len].decode('utf-8'))
    return f, header, 8 + header_size


def walk(node, prefix=''):
    """Yield (path, node) for every file entry, directories flattened away."""
    for name, meta in node.get('files', {}).items():
        p = prefix + '/' + name
        if 'files' in meta:
            yield from walk(meta, p)
        else:
            yield p, meta


def integrity_for(data, block_size=4194304):
    blocks = [hashlib.sha256(data[i:i + block_size]).hexdigest()
              for i in range(0, len(data), block_size)] or [hashlib.sha256(b'').hexdigest()]
    return {'algorithm': 'SHA256',
            'hash': hashlib.sha256(data).hexdigest(),
            'blockSize': block_size,
            'blocks': blocks}


def serialize_header(header):
    js = json.dumps(header, separators=(',', ':')).encode('utf-8')
    payload = struct.pack('<I', len(js)) + js
    pad = (4 - (len(payload) + 4) % 4) % 4
    body = struct.pack('<I', len(payload) + 4 + pad - 4) + payload + b'\0' * pad
    return struct.pack('<I', 4) + struct.pack('<I', len(body)) + body


def cmd_check(args):
    f, header, base = read_asar(args.asar)
    entries = list(walk(header))
    unpacked = [p for p, n in entries if n.get('offset') is None]
    patched = False
    for p, n in entries:
        if p == TARGET and n.get('offset') is not None:
            f.seek(base + int(n['offset']))
            patched = MARKER.encode() in f.read(n['size'])
    print(f'entries       : {len(entries)}')
    print(f'unpacked      : {len(unpacked)}')
    for p in unpacked:
        print(f'                {p}')
    print(f'target present: {any(p == TARGET for p, _ in entries)}')
    print(f'already patched: {patched}')

    # self-test: the header's integrity hash must be SHA256 of the file content
    for p, n in entries:
        if n.get('offset') is not None and n.get('integrity') and n['size'] > 0:
            f.seek(base + int(n['offset']))
            data = f.read(n['size'])
            ok = integrity_for(data, n['integrity'].get('blockSize', 4194304)) == n['integrity']
            print(f'integrity self-test on {p}: {"PASS" if ok else "FAIL"}')
            if not ok:
                raise SystemExit('integrity scheme mismatch -- refusing to proceed')
            break
    return 0 if any(p == TARGET for p, _ in entries) else 1


def cmd_patch(args):
    payload = open(args.payload, 'rb').read()
    appendix = (b'\n;/* ' + MARKER.encode() + b' */\n'
                b'try{(function(){var w=require("electron").webFrame;'
                b'if(!w||typeof w.executeJavaScript!=="function")return;'
                b'var S=' + json.dumps(payload.decode('utf-8')).encode('utf-8') + b';'
                b'var go=function(){try{w.executeJavaScript(S)}'
                b'catch(e){console.error("[ctx-badge] inject failed",e)}};'
                b'if(document.readyState==="loading")'
                b'document.addEventListener("DOMContentLoaded",go,{once:true});'
                b'else go()})()}catch(e){console.error("[ctx-badge] preload failed",e)}\n'
                b'/* <<< ctx-badge v1 <<< */\n')

    f, header, base = read_asar(args.src)
    entries = list(walk(header))
    by_path = dict(entries)
    if TARGET not in by_path:
        raise SystemExit(f'ANCHOR MISSING: {TARGET} is not in {args.src}.\n'
                         'The app layout changed. Refusing to produce a silently '
                         'unpatched archive. Re-inspect the bundle before retrying.')

    # asar deduplicates identical files: several entries can share one (offset, size).
    # Rebuild keyed on that pair so dedup survives and the size delta stays exact.
    def key_of(n):
        return (int(n['offset']), n['size'])

    keys = {p: key_of(n) for p, n in entries if n.get('offset') is not None}
    tgt_key = keys[TARGET]
    sharers = [p for p, k in keys.items() if k == tgt_key]
    if sharers != [TARGET]:
        raise SystemExit(f'{TARGET} shares its content with {sharers}; '
                         'patching it would alter those too. Refusing.')

    blobs, new_at, offset = [], {}, 0
    for k in sorted(set(keys.values())):
        f.seek(base + k[0])
        data = f.read(k[1])
        if k == tgt_key:
            if MARKER.encode() in data:
                raise SystemExit('source archive is already patched -- patch from the backup')
            data = data + appendix
        new_at[k] = (offset, len(data))
        blobs.append(data)
        offset += len(data)

    for p, n in entries:
        if n.get('offset') is None:
            continue
        no, ns = new_at[keys[p]]
        n['offset'] = str(no)
        n['size'] = ns
        if p == TARGET and 'integrity' in n:
            n['integrity'] = integrity_for(blobs[sorted(set(keys.values())).index(tgt_key)],
                                           n['integrity'].get('blockSize', 4194304))

    out = open(args.dst, 'wb')
    hdr = serialize_header(header)
    out.write(hdr)
    for b in blobs:
        out.write(b)
    out.close()
    print(f'wrote {args.dst} ({len(hdr) + offset:,} bytes; '
          f'{TARGET} grew by {len(appendix):,})')
    return 0


def cmd_verify(args):
    fo, ho, bo = read_asar(args.orig)
    fn, hn, bn = read_asar(args.new)
    eo, en = dict(walk(ho)), dict(walk(hn))
    problems = []

    if set(eo) != set(en):
        problems.append(f'entry set differs ({len(eo)} vs {len(en)})')
    up_o = {p for p, n in eo.items() if n.get('offset') is None}
    up_n = {p for p, n in en.items() if n.get('offset') is None}
    if up_o != up_n:
        problems.append(f'unpacked set differs: {up_o ^ up_n}')

    changed = []
    for p in sorted(set(eo) & set(en)):
        no, nn = eo[p], en[p]
        if no.get('offset') is None:
            continue
        fo.seek(bo + int(no['offset'])); do = fo.read(no['size'])
        fn.seek(bn + int(nn['offset'])); dn = fn.read(nn['size'])
        if do != dn:
            changed.append(p)
        if 'integrity' in nn:
            want = integrity_for(dn, nn['integrity'].get('blockSize', 4194304))
            if want != nn['integrity']:
                problems.append(f'integrity mismatch for {p}')

    if changed != [TARGET]:
        problems.append(f'expected exactly {TARGET} to change, got {changed}')
    marker_count = 0
    if TARGET in en:
        fn.seek(bn + int(en[TARGET]['offset']))
        marker_count = fn.read(en[TARGET]['size']).count(MARKER.encode())
    if marker_count != 1:
        problems.append(f'marker appears {marker_count} times, expected 1')
    import os
    grew = os.path.getsize(args.new) - os.path.getsize(args.orig)
    delta = en[TARGET]['size'] - eo[TARGET]['size']
    if grew != delta:
        problems.append(f'archive grew {grew:,} but {TARGET} grew {delta:,} '
                        '-- dedup or layout was not preserved')
    print(f'size delta   : {grew:,} (target grew {delta:,})')

    print(f'entries      : {len(en)} (orig {len(eo)})')
    print(f'unpacked     : {sorted(up_n)}')
    print(f'changed files: {changed}')
    print(f'marker count : {marker_count}')
    if problems:
        print('\nFAILED:')
        for p in problems:
            print('  -', p)
        return 1
    print('\nVERIFY OK')
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check');  c.add_argument('asar')
    p = sub.add_parser('patch');  p.add_argument('--src', required=True)
    p.add_argument('--dst', required=True); p.add_argument('--payload', required=True)
    v = sub.add_parser('verify'); v.add_argument('--orig', required=True)
    v.add_argument('--new', required=True)
    a = ap.parse_args()
    return {'check': cmd_check, 'patch': cmd_patch, 'verify': cmd_verify}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
