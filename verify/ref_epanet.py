"""공식 EPANET 툴킷(DLL)으로 .inp 를 원본 그대로 해석해 보고 시각마다 절점 수압·수두, 관로 유량·유속을 JSON 으로 저장한다.

사용: python ref_epanet.py <epanet2.dll> <입력.inp> <출력.json>
물길(epanetRunner.ts)과 같은 순서로 해석한다: ENopenH → ENinitH(0) → ENrunH/ENnextH, 보고 시각(reportStart + k·reportStep)만 기록.
"""
import ctypes
import json
import os
import sys
import tempfile

EN_ELEVATION, EN_DEMAND, EN_HEAD, EN_PRESSURE = 0, 9, 10, 11
EN_FLOW, EN_VELOCITY, EN_HEADLOSS = 8, 9, 10
EN_NODECOUNT, EN_LINKCOUNT = 0, 2
EN_DURATION, EN_HYDSTEP, EN_REPORTSTEP, EN_REPORTSTART = 0, 1, 5, 6


def main(dll_path: str, inp: str, out: str) -> None:
    en = ctypes.WinDLL(dll_path) if os.name == 'nt' else ctypes.CDLL(dll_path)
    ver = ctypes.c_int()
    en.ENgetversion(ctypes.byref(ver))
    tmp = tempfile.mkdtemp()
    rpt = os.path.join(tmp, 'r.rpt').encode()
    outb = os.path.join(tmp, 'r.out').encode()
    err = en.ENopen(inp.encode(), rpt, outb)
    if err > 100:
        raise SystemExit(f'ENopen error {err}')

    def count(kind: int) -> int:
        n = ctypes.c_int()
        en.ENgetcount(kind, ctypes.byref(n))
        return n.value

    def idof(fn, i: int) -> str:
        b = ctypes.create_string_buffer(64)
        fn(i, b)
        return b.value.decode('latin-1')

    def tparam(code: int) -> int:
        v = ctypes.c_long()
        en.ENgettimeparam(code, ctypes.byref(v))
        return v.value

    nn, nl = count(EN_NODECOUNT), count(EN_LINKCOUNT)
    node_ids = [idof(en.ENgetnodeid, i) for i in range(1, nn + 1)]
    link_ids = [idof(en.ENgetlinkid, i) for i in range(1, nl + 1)]
    duration, rstep, rstart = tparam(EN_DURATION), tparam(EN_REPORTSTEP) or tparam(EN_HYDSTEP) or 3600, tparam(EN_REPORTSTART)

    v = ctypes.c_float()

    def node(i: int, p: int) -> float:
        en.ENgetnodevalue(i, p, ctypes.byref(v))
        return round(v.value, 6)

    def link(i: int, p: int) -> float:
        en.ENgetlinkvalue(i, p, ctypes.byref(v))
        return round(v.value, 6)

    steps = []
    en.ENopenH()
    en.ENinitH(0)
    t = ctypes.c_long()
    tstep = ctypes.c_long(1)
    while True:
        e = en.ENrunH(ctypes.byref(t))
        if e > 100:
            raise SystemExit(f'ENrunH error {e} at {t.value}')
        if t.value >= rstart and (t.value - rstart) % rstep == 0 or duration == 0:
            steps.append({
                't': t.value,
                'pressure': [node(i, EN_PRESSURE) for i in range(1, nn + 1)],
                'head': [node(i, EN_HEAD) for i in range(1, nn + 1)],
                'demand': [node(i, EN_DEMAND) for i in range(1, nn + 1)],
                'flow': [link(i, EN_FLOW) for i in range(1, nl + 1)],
                'velocity': [link(i, EN_VELOCITY) for i in range(1, nl + 1)],
            })
        en.ENnextH(ctypes.byref(tstep))
        if tstep.value <= 0:
            break
    en.ENcloseH()
    en.ENclose()
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'engine': ver.value, 'nodeIds': node_ids, 'linkIds': link_ids, 'steps': steps}, f)
    print(f'{os.path.basename(inp)}: engine {ver.value}, nodes {nn}, links {nl}, steps {len(steps)}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
