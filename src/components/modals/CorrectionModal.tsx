import { FileUp, LoaderCircle, Mountain, Route } from 'lucide-react';
import { NgiiLink } from '../ui/DataLinks';
import { useRef, useState, type ReactNode } from 'react';
import { fetchOsmRoads } from '../../app/osmRoads';
import { interpolatorFromFiles, sampleTerrainTiles } from '../../app/terrainFetch';
import { computeLinkLength } from '../../core/model/networkEdit';
import { snapNetworkToRoads, type SnapResult } from '../../core/model/roadSnap';
import { formatNumber, isUsUnits } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { bboxOf } from '../../utils/geoMath';
import { Button, NumberField } from '../ui/fields';
import { Modal } from '../ui/Modal';

function Group({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-md border border-line p-3 last:mb-0">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, unit, children }: { label: string; unit?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[170px_120px_1fr] items-center gap-3 py-0.5">
      <span className="text-xs text-ink-soft">
        {label}
        {unit && <span className="ml-1 text-ink-muted">{unit}</span>}
      </span>
      {children}
    </label>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{children}</p>;

/* ------------------------------------------------------------------ 도로 따라 보정 */

function RoadSnapSection() {
  const [tolerance, setTolerance] = useState(25);
  const [recalc, setRecalc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ snap: SnapResult; revision: number } | null>(null);
  const revision = useNetworkStore((s) => s.revision);

  const analyze = async () => {
    const { model, revision: rev } = useNetworkStore.getState();
    const points = Object.values(model.nodes).map((n) => n.position);
    const box = bboxOf(points);
    if (!box) return;
    setBusy(true);
    setError(null);
    try {
      const pad = 0.002; // 약 200 m
      const roads = await fetchOsmRoads(box[1] - pad, box[0] - pad, box[3] + pad, box[2] + pad);
      const snap = snapNetworkToRoads(model, roads, { tolerance, metersPerLengthUnit: isUsUnits(model.options.flowUnits) ? 0.3048 : 1 });
      setResult({ snap, revision: rev });
      useUIStore.getState().setHighlight({ nodeIds: [...snap.nodes.keys()], linkIds: [...snap.vertices.keys()] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!result) return;
    const { snap } = result;
    const touched = new Set<string>(snap.vertices.keys());
    useNetworkStore.getState().commit((draft) => {
      for (const [id, p] of snap.nodes) if (draft.nodes[id]) draft.nodes[id].position = p;
      for (const [id, v] of snap.vertices) if (draft.links[id]) draft.links[id].vertices = v;
      for (const id in draft.links) {
        const link = draft.links[id];
        if (snap.nodes.has(link.startNodeId) || snap.nodes.has(link.endNodeId)) touched.add(id);
      }
      if (recalc) {
        for (const id of touched) {
          const link = draft.links[id];
          if (link?.type !== 'pipe') continue;
          link.length = computeLinkLength(draft, link);
          link.isCustomLength = false;
        }
      }
    });
    useUIStore.getState().pushToast({
      level: 'success',
      title: '관로를 도로에 맞췄습니다',
      message: `절점 ${snap.stats.nodesMoved}개 이동(평균 ${snap.stats.meanMove.toFixed(1)} m), 관로 ${snap.stats.linksRouted}개를 도로를 따라 다시 그렸습니다.${recalc ? ' 관로 연장도 새 형상으로 다시 계산했습니다.' : ' 관로 연장(수리계산 값)은 그대로입니다.'} 되돌리려면 Ctrl+Z.`,
    });
    setResult(null);
  };

  const stale = result && result.revision !== revision;

  return (
    <Group icon={<Route size={14} />} title="도로 따라 관로 형상 보정">
      <Row label="절점을 옮길 최대 거리" unit="m">
        <NumberField value={tolerance} min={1} onCommit={setTolerance} />
      </Row>
      <label className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
        <input type="checkbox" className="accent-accent" checked={recalc} onChange={(e) => setRecalc(e.target.checked)} />
        관로 연장도 새 형상으로 다시 계산 (끄면 .inp 의 연장 값을 유지 — 수리계산 결과가 바뀌지 않음)
      </label>
      <Note>
        절점을 가장 가까운 도로 중심선(교차로 우선) 위로 옮기고, 양 끝이 도로 위에 놓인 관로는 도로를 따라 꺾임점을 다시 만듭니다. 이 거리보다 도로에서 먼
        절점과, 도로로 돌아가면 1.5배 넘게 길어지는 관로(논·산을 가로지르는 관로)는 그대로 둡니다. 수원지·배수지는 옮기지 않습니다. 도로 자료: OpenStreetMap.
      </Note>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={() => void analyze()} disabled={busy}>
          {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Route size={13} />}
          {busy ? '도로 자료 받는 중…' : '분석 (미리 보기)'}
        </Button>
        <Button variant="primary" disabled={!result || busy || Boolean(stale)} onClick={apply}>
          적용
        </Button>
        {stale && <span className="text-[11px] text-warn">분석 뒤 관망이 바뀌었습니다. 다시 분석하세요.</span>}
      </div>
      {error && <p className="mt-2 text-xs text-[#f3a5a5]">{error}</p>}
      {result && (
        <div className="mt-2 rounded bg-raised/50 p-2 text-xs tabular-nums text-ink">
          절점 {result.snap.stats.nodesConsidered}개 중 <b>{result.snap.stats.nodesMoved}개 이동</b> (평균 {result.snap.stats.meanMove.toFixed(1)} m, 최대{' '}
          {result.snap.stats.maxMove.toFixed(1)} m), {result.snap.stats.nodesOnRoad}개는 이미 도로 위 · 관로 <b>{result.snap.stats.linksRouted}개</b>를 도로 따라 다시 그림
          <span className="block text-[11px] text-ink-muted">지도에 노란색으로 강조했습니다. 확인한 뒤 ‘적용’을 누르세요.</span>
        </div>
      )}
    </Group>
  );
}

/* ------------------------------------------------------------------ 지반고 보정 */

interface ElevRow {
  id: string;
  old: number;
  next: number;
}

function ElevationSection() {
  const [source, setSource] = useState<'tiles' | 'file'>('tiles');
  const [depth, setDepth] = useState(0);
  const [threshold, setThreshold] = useState(0.5);
  /** 이보다 크게 차이 나면 자료·도면 오류일 가능성이 커서 바꾸지 않는다. */
  const [maxChange, setMaxChange] = useState(30);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<{ list: ElevRow[]; missing: number; revision: number; label: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const revision = useNetworkStore((s) => s.revision);

  const analyze = async () => {
    const { model, revision: rev } = useNetworkStore.getState();
    const junctions = Object.values(model.nodes).filter((n) => n.type === 'junction');
    if (junctions.length === 0) return;
    setError(null);
    try {
      let values: (number | undefined)[];
      let label: string;
      if (source === 'tiles') {
        setBusy('지형 타일 받는 중…');
        values = await sampleTerrainTiles(
          junctions.map((n) => n.position),
          (d, t) => setBusy(`지형 타일 받는 중… ${d}/${t}`),
        );
        label = '온라인 지형 타일 (SRTM 30 m 급)';
      } else {
        if (files.length === 0) throw new Error('수치지형도 파일(.dxf, .shp+.dbf+.prj 또는 .zip) 또는 표고점 텍스트(.xyz·.txt·.csv)를 먼저 고르세요.');
        setBusy('수치지형도 읽는 중…');
        const fallback = model.crs.kind === 'epsg' ? model.crs.code : null;
        const { idw, points, layers } = await interpolatorFromFiles(files, fallback);
        values = junctions.map((n) => idw.at(n.position)?.z);
        label = `수치지형도 (${layers.join(', ')} · 표고 ${points.toLocaleString()}점)`;
      }
      const list: ElevRow[] = [];
      let missing = 0;
      junctions.forEach((n, i) => {
        const v = values[i];
        if (v === undefined || !Number.isFinite(v)) {
          missing++;
          return;
        }
        list.push({ id: n.id, old: n.elevation, next: Math.round((v - depth) * 100) / 100 });
      });
      setRows({ list, missing, revision: rev, label });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const changes = rows ? rows.list.filter((r) => Math.abs(r.next - r.old) >= threshold && Math.abs(r.next - r.old) <= maxChange) : [];
  const suspicious = rows ? rows.list.filter((r) => Math.abs(r.next - r.old) > maxChange) : [];
  const stats = (() => {
    if (!rows || rows.list.length === 0) return null;
    const diffs = rows.list.map((r) => r.next - r.old);
    const meanAbs = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const maxAbs = Math.max(...diffs.map(Math.abs));
    return { meanAbs, mean, maxAbs };
  })();
  const stale = rows && rows.revision !== revision;

  const apply = () => {
    if (!rows) return;
    const map = new Map(changes.map((r) => [r.id, r.next]));
    useNetworkStore.getState().commit((draft) => {
      for (const [id, z] of map) {
        const node = draft.nodes[id];
        if (node?.type === 'junction') node.elevation = z;
      }
    });
    useUIStore.getState().pushToast({
      level: 'success',
      title: `절점 표고 ${map.size}개를 바꿨습니다`,
      message: `자료: ${rows.label}${depth ? ` · 매설 깊이 ${depth} m 차감` : ''}. 수압이 달라지므로 해석을 다시 실행하세요. 되돌리려면 Ctrl+Z.`,
    });
    setRows(null);
  };

  // 표에는 의심 항목을 먼저(빨강), 그다음 바꿀 항목을 차이가 큰 순으로 보인다
  const sorted = [...suspicious, ...changes].sort((a, b) => Math.abs(b.next - b.old) - Math.abs(a.next - a.old));

  return (
    <Group icon={<Mountain size={14} />} title="절점 표고(지반고) 보정">
      <div className="mb-2 flex gap-4 text-xs text-ink-soft">
        <label className="flex items-center gap-1.5">
          <input type="radio" className="accent-accent" checked={source === 'tiles'} onChange={() => setSource('tiles')} />
          온라인 지형 자료 (키 불필요)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" className="accent-accent" checked={source === 'file'} onChange={() => setSource('file')} />
          수치지형도·표고점 파일
        </label>
      </div>
      {source === 'tiles' ? (
        <Note>
          AWS Open Data 지형 타일(Terrarium)에서 읽습니다. 국내는 SRTM 30 m 급 자료라 수 m 오차가 있고, 건물·나무 높이가 섞일 수 있습니다. 대략적인 점검·보정용이며
          설계용으로는 수치지형도를 권합니다.
        </Note>
      ) : (
        <div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".dxf,.shp,.dbf,.prj,.cpg,.shx,.zip,.xyz,.txt,.csv,.pts"
            className="hidden"
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <div className="flex items-center gap-2">
            <Button onClick={() => fileInput.current?.click()}>
              <FileUp size={13} />
              파일 선택
            </Button>
            <span className="truncate text-[11px] text-ink-muted">{files.length > 0 ? files.map((f) => f.name).join(', ') : '선택한 파일 없음'}</span>
          </div>
          <Note>
            국토지리정보원 수치지형도를 넣으세요: DXF(등고선·표고점 레이어를 자동으로 고름) 또는 표고점·등고선 Shapefile(.shp+.dbf+.prj 를 함께 또는 .zip). 속성 CONT·NUME·ELEV·표고 또는 Z 좌표에서 표고를 읽고, 반경
            300 m 안 가까운 8개 점을 거리 가중 평균합니다. 측량 성과·CAD 점고도·DEM 을 점으로 내보낸 표고점 텍스트(.xyz·.txt·.csv, 줄마다 X Y Z 또는 번호 X Y Z)도
            넣을 수 있습니다.
            <NgiiLink />
          </Note>
        </div>
      )}
      <Row label="매설 깊이 (지반고에서 뺌)" unit="m">
        <NumberField value={depth} min={0} onCommit={setDepth} />
      </Row>
      <Row label="이 값 이상 차이 날 때만 변경" unit="m">
        <NumberField value={threshold} min={0} onCommit={setThreshold} />
      </Row>
      <Row label="이 값보다 크면 의심 — 변경 안 함" unit="m">
        <NumberField value={maxChange} min={0} onCommit={setMaxChange} />
      </Row>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={() => void analyze()} disabled={busy !== null}>
          {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Mountain size={13} />}
          {busy ?? '분석 (미리 보기)'}
        </Button>
        <Button variant="primary" disabled={!rows || changes.length === 0 || busy !== null || Boolean(stale)} onClick={apply}>
          {changes.length > 0 ? `${changes.length}개 적용` : '적용'}
        </Button>
        {stale && <span className="text-[11px] text-warn">분석 뒤 관망이 바뀌었습니다. 다시 분석하세요.</span>}
      </div>
      {error && <p className="mt-2 text-xs text-[#f3a5a5]">{error}</p>}
      {rows && stats && (
        <div className="mt-2">
          <p className="text-xs tabular-nums text-ink">
            {rows.list.length}개 절점 비교 · 평균 차이 {stats.mean >= 0 ? '+' : ''}
            {stats.mean.toFixed(2)} m · 평균 절댓값 {stats.meanAbs.toFixed(2)} m · 최대 {stats.maxAbs.toFixed(2)} m
            {rows.missing > 0 && <span className="text-warn"> · {rows.missing}개는 자료 범위 밖</span>}
          </p>
          {suspicious.length > 0 && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink">
              <span className="font-semibold text-[#f3a5a5]">의심 {suspicious.length}개</span>는 {maxChange} m 넘게 달라 바꾸지 않습니다. 대개 그 절점의 도면 위치가 틀렸거나(관로 연장과
              도면 길이가 크게 다름) 지형 자료가 산 경사면을 잘못 읽은 경우입니다. 행을 눌러 위치를 확인하세요.
            </p>
          )}
          <div className="mt-1.5 max-h-48 overflow-auto rounded border border-line">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">절점</th>
                  <th className="px-2 py-1 text-right font-medium">현재 (.inp)</th>
                  <th className="px-2 py-1 text-right font-medium">새 값</th>
                  <th className="px-2 py-1 text-right font-medium">차이</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 200).map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-t border-line/50 hover:bg-raised"
                    onClick={() => {
                      const n = useNetworkStore.getState().model.nodes[r.id];
                      if (n) useUIStore.getState().flyTo(n.position, 17);
                    }}
                  >
                    <td className="px-2 py-0.5 text-ink">{r.id}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{formatNumber(r.old, 2)}</td>
                    <td className="px-2 py-0.5 text-right text-ink">{formatNumber(r.next, 2)}</td>
                    <td
                      className={`px-2 py-0.5 text-right ${
                        Math.abs(r.next - r.old) > maxChange ? 'font-semibold text-[#f3a5a5]' : Math.abs(r.next - r.old) >= 5 ? 'text-warn' : 'text-ink-soft'
                      }`}
                    >
                      {r.next - r.old >= 0 ? '+' : ''}
                      {formatNumber(r.next - r.old, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">차이가 큰 순. 행을 누르면 지도에서 그 절점으로 갑니다.</p>
        </div>
      )}
    </Group>
  );
}

function CorrectionDialog() {
  const close = () => useUIStore.getState().openModal(null);
  return (
    <Modal title="관망 위치·표고 보정" onClose={close} widthClass="w-[720px]" footer={<Button onClick={close}>닫기</Button>}>
      <RoadSnapSection />
      <ElevationSection />
    </Modal>
  );
}

/** 도로 따라 관로 형상 보정 + 지형 자료로 절점 표고 보정 대화상자. */
export function CorrectionModal() {
  const open = useUIStore((s) => s.modal === 'correction');
  return open ? <CorrectionDialog /> : null;
}
