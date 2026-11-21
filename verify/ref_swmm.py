"""공식 EPA SWMM(swmm-toolkit, USEPA 소스 그대로 컴파일된 엔진)으로 .inp 를 해석하고, 출력(.out)의 보고 시각별
절점 수심·수두, 관로 유량·유속과 보고서(.rpt)의 연속방정식 오차를 JSON 으로 저장한다.

사용: python ref_swmm.py <입력.inp> <출력.json>
"""
import json
import os
import re
import sys
import tempfile

from swmm.toolkit import output, shared_enum, solver

NA, LA, ET = shared_enum.NodeAttribute, shared_enum.LinkAttribute, shared_enum.ElementType


def continuity(rpt_text: str) -> dict:
    """보고서의 '... Continuity' 표마다 'Continuity Error (%)' 값."""
    out = {}
    for m in re.finditer(r'\*+\s*\n\s*(Runoff Quantity|Flow Routing|Groundwater|Runoff Quality|Quality Routing) Continuity[\s\S]*?Continuity Error \(%\) \.+\s*(-?[\d.]+)', rpt_text):
        out[m.group(1)] = float(m.group(2))
    return out


def main(inp: str, out_json: str) -> None:
    tmp = tempfile.mkdtemp()
    rpt, out = os.path.join(tmp, 'r.rpt'), os.path.join(tmp, 'r.out')
    solver.swmm_run(inp, rpt, out)
    h = output.init()
    output.open(h, out)
    sizes = output.get_proj_size(h)  # [소유역, 절점, 관로, (시스템), 오염물질]
    n_node, n_link = sizes[1], sizes[2]
    periods = output.get_times(h, shared_enum.Time.NUM_PERIODS)
    node_ids = [output.get_elem_name(h, ET.NODE, i) for i in range(n_node)]
    link_ids = [output.get_elem_name(h, ET.LINK, i) for i in range(n_link)]

    def nseries(attr):
        return [[round(v, 6) for v in output.get_node_series(h, i, attr, 0, periods - 1)] for i in range(n_node)]

    def lseries(attr):
        return [[round(v, 6) for v in output.get_link_series(h, i, attr, 0, periods - 1)] for i in range(n_link)]

    data = {
        'engine': solver.swmm_get_version(),
        'periods': periods,
        'nodeIds': node_ids,
        'linkIds': link_ids,
        'depth': nseries(NA.INVERT_DEPTH),
        'head': nseries(NA.HYDRAULIC_HEAD),
        'flow': lseries(LA.FLOW_RATE),
        'velocity': lseries(LA.FLOW_VELOCITY),
        'continuity': continuity(open(rpt, encoding='utf-8', errors='replace').read()),
    }
    output.close(h)
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    print(f'{os.path.basename(inp)}: SWMM {data["engine"]}, nodes {n_node}, links {n_link}, periods {periods}, continuity {data["continuity"]}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
