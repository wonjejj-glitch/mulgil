"""compare.json → 한국어 비교표(report.md). 사용: python report.py <compare.json> <report.md>"""
import json
import sys

REF_NAME = {
    'owa': '공식 EPANET 2.3 (OWA)',
    'epa22': '미국 EPA EPANET 2.2',
    'owa-exported': '공식 EPANET 2.3 — 물길이 내보낸 .inp',
    'swmm': '미국 EPA SWMM 5.2',
}


def fmt(x: float, d: int = 6) -> str:
    if x == 0:
        return '0'
    if abs(x) < 10 ** -d:
        return f'{x:.1e}'
    return f'{x:.{d}f}'.rstrip('0').rstrip('.')


def main(src: str, dst: str) -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    rows = json.load(open(src, encoding='utf-8'))
    out = ['# 물길 계산 엔진 검증 — 공식 엔진과 결과 비교', '']
    out.append('같은 관망을 **물길**(웹 화면에서 쓰는 해석 경로 그대로)과 **공식 엔진**으로 각각 해석해, 보고 시각마다 모든 절점·관로 값을 비교했습니다.')
    out.append('차이는 물길 값 − 공식 값의 절댓값입니다. 단위는 각 관망 파일의 단위(GPM 관망은 수압 psi·유량 GPM, LPS 관망은 m·L/s, SWMM 은 파일의 유량 단위)입니다.')
    out.append('')

    water = [r for r in rows if r['kind'] == 'water']
    if water:
        out += ['## 상수 (EPANET)', '',
                '| 관망 | 비교 대상 | 절점 · 관로 · 시각 | 수압 최대 차이 | 수두 최대 차이 | 유량 최대 차이 | 유량 최대 상대 차이 | 유속 최대 차이 |',
                '|---|---|---|---|---|---|---|---|']
        for r in water:
            s = r['stats']
            out.append(f"| {r['net']} ({r['units']}) | {REF_NAME.get(r['ref'], r['ref'])} | {r['nodes']} · {r['links']} · {r['steps']} | "
                       f"{fmt(s['pressure']['maxAbs'])} | {fmt(s['head']['maxAbs'])} | {fmt(s['flow']['maxAbs'])} | {fmt(s['flow']['maxRel'] * 100, 4)}% | {fmt(s['velocity']['maxAbs'])} |")
        out.append('')
        out.append(f"물길 엔진: {water[0]['mulgilEngine']}. 비교한 값의 개수: " + ', '.join(f"{r['net']} {sum(v['n'] for v in r['stats'].values()):,}개" for r in water if r['ref'] == 'owa') + '.')
        out.append('')

    sewer = [r for r in rows if r['kind'] == 'sewer']
    if sewer:
        out += ['## 하수 · 우수 (SWMM)', '',
                '| 관망 | 절점 · 관로 · 시각 | 수심 최대 차이 | 유량 최대 차이 | 유량 최대 상대 차이 | 유속 최대 차이 | 흐름 연속 오차 % (물길 / 공식) |',
                '|---|---|---|---|---|---|---|']
        for r in sewer:
            if 'error' in r:
                out.append(f"| {r['net']} | 물길 해석 실패: {r['error']} | | | | | |")
                continue
            s = r['stats']
            c = r['continuity']
            fr = f"{c['mulgil'].get('Flow Routing', '-')} / {c['official'].get('Flow Routing', '-')}"
            out.append(f"| {r['net']} ({r['units']}) | {r['nodes']} · {r['links']} · {r['steps']} | {fmt(s['depth']['maxAbs'])} | {fmt(s['flow']['maxAbs'])} | "
                       f"{fmt(s['flow']['maxRel'] * 100, 4)}% | {fmt(s['velocity']['maxAbs'])} | {fr} |")
        engines = sorted({(r.get('mulgilEngine', ''), r.get('refEngine', '')) for r in sewer if 'error' not in r})
        out.append('')
        out.append('엔진: ' + '; '.join(f'물길 {m} / 공식 {o}' for m, o in engines) + '.')
        out.append('')

    out += ['## 가장 큰 차이가 난 곳', '']
    for r in rows:
        if 'stats' not in r:
            continue
        key = 'flow'
        w = r['stats'][key]['worst']
        if w:
            out.append(f"- {r['net']} · {REF_NAME.get(r['ref'], r['ref'])} · 유량: {w}")
    out.append('')
    open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
    print('\n'.join(out))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
