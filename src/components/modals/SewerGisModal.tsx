/** 하수도 GIS(SHP) → 하수 관망: 용도·구역 고르기 대화상자. 읽기는 app/sewerGisImport.ts, 변환은 core/sewer/fromGis.ts. */
import { LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createSewerFromGis } from '../../app/sewerGisImport';
import { insideRings, usageLabel, type GisRegion } from '../../core/sewer/fromGis';
import { useSewerGisStore } from '../../store/useSewerGisStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField } from '../ui/fields';
import { Modal } from '../ui/Modal';

type RegionKind = 'area' | 'outlet' | 'all';

export function SewerGisModal() {
  const data = useSewerGisStore((s) => s.data);
  const busy = useSewerGisStore((s) => s.busy);
  const error = useSewerGisStore((s) => s.error);
  const close = () => useUIStore.getState().openModal(null);

  const usageRows = useMemo(() => (data ? [...data.net.usages.entries()].sort((a, b) => b[1] - a[1]) : []), [data]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const usages = useMemo(() => picked ?? (usageRows[0] ? [usageRows[0][0]] : []), [picked, usageRows]);
  const [kind, setKind] = useState<RegionKind | null>(null);
  const regionKind: RegionKind = kind ?? (data && data.areas.length > 0 ? 'area' : 'outlet');
  const [areaIndex, setAreaIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [outlet, setOutlet] = useState('');
  const [minPipes, setMinPipes] = useState(5);
  const [defaultMm, setDefaultMm] = useState(300);

  const areaChoices = useMemo(
    () => (data ? data.areas.map((a, i) => ({ a, i })).filter(({ a }) => !filter || `${a.layer} ${a.name}`.includes(filter)) : []),
    [data, filter],
  );
  const area = data?.areas[areaIndex];

  const preview = useMemo(() => {
    if (!data) return null;
    let n = 0;
    for (const l of data.net.links) {
      if (!usages.includes(l.usage)) continue;
      if (regionKind === 'area' && (!area || !insideRings(l.mid, area.rings))) continue;
      n++;
    }
    return regionKind === 'outlet' ? null : n;
  }, [data, usages, regionKind, area]);

  const region: GisRegion | null =
    regionKind === 'all' ? { kind: 'all' } : regionKind === 'area' ? (area ? { kind: 'area', rings: area.rings } : null) : outlet.trim() ? { kind: 'outlet', nodeId: outlet.trim() } : null;

  const create = () => {
    if (!data || !region) return;
    createSewerFromGis({
      usages,
      region,
      minPipes: Math.max(1, Math.round(minPipes)),
      defaultDiameter: Math.max(0.1, defaultMm / 1000),
      name: regionKind === 'area' && area ? `${area.name} (${usages.map(usageLabel).join('·')})` : `${data.label.replace(/\.(shp|zip)$/i, '')} (${usages.map(usageLabel).join('·')})`,
    });
  };

  const s = data?.net.stats;
  return (
    <Modal
      title="하수도 GIS(SHP)에서 관망 만들기"
      onClose={close}
      widthClass="w-[640px]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-muted">
            {preview !== null && `관거 ${preview.toLocaleString()}개 해당`}
            {preview !== null && preview > 5000 && ' — 많으면 화면·해석이 느립니다. 구역을 좁히세요.'}
          </span>
          <Button onClick={close}>취소</Button>
          <Button variant="primary" disabled={!data || !region || usages.length === 0 || busy !== null} onClick={create}>
            관망 만들기
          </Button>
        </>
      }
    >
      {busy && (
        <p className="flex items-center gap-2 text-xs text-ink-soft">
          <LoaderCircle size={14} className="animate-spin" /> {busy}
        </p>
      )}
      {error && <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{error}</p>}
      {data && s && (
        <div className="space-y-4 text-xs">
          <section>
            <p className="text-ink-soft">
              관거 {s.pipes.toLocaleString()}개 · 맨홀 {s.manholes.toLocaleString()}개 · 좌표계 {data.crsLabel}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              관 끝점 연결: 맨홀 번호로 {s.byId.toLocaleString()} · 거리 1 m 이내 맨홀 {s.bySnap.toLocaleString()} · 맨홀 없어 만든 절점 {s.virtual.toLocaleString()}
              {s.skipped > 0 && ` · 길이 0 등으로 뺀 관 ${s.skipped}`}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-muted">레이어: {data.layers.join(', ')}</p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold text-ink">용도</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {usageRows.map(([code, count]) => (
                <label key={code} className="flex items-center gap-1 text-ink-soft">
                  <input
                    type="checkbox"
                    checked={usages.includes(code)}
                    onChange={(e) => setPicked(e.target.checked ? [...usages, code] : usages.filter((u) => u !== code))}
                  />
                  {usageLabel(code)} <span className="text-ink-muted">{count.toLocaleString()}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              표준 코드 뜻(SBA001 합류 · 002 차집 · 003 우수 · 004 오수)은 자료로 추정한 것입니다. 오수와 우수는 따로 가져오세요.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold text-ink">구역</h3>
            <div className="flex gap-4 text-ink-soft">
              {data.areas.length > 0 && (
                <label className="flex items-center gap-1">
                  <input type="radio" checked={regionKind === 'area'} onChange={() => setKind('area')} /> 처리분구·배수분구 경계
                </label>
              )}
              <label className="flex items-center gap-1">
                <input type="radio" checked={regionKind === 'outlet'} onChange={() => setKind('outlet')} /> 하류 맨홀의 상류 전체
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={regionKind === 'all'} onChange={() => setKind('all')} /> 전체
              </label>
            </div>
            {regionKind === 'area' && (
              <div className="mt-2 flex gap-2">
                <input
                  className="w-32 rounded border border-line bg-raised px-2 py-1 text-ink"
                  placeholder="이름 찾기"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <select className="flex-1 rounded border border-line bg-raised px-2 py-1 text-ink" value={areaIndex} onChange={(e) => setAreaIndex(Number(e.target.value))}>
                  {areaChoices.map(({ a, i }) => (
                    <option key={i} value={i}>
                      {a.layer} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {regionKind === 'outlet' && (
              <div className="mt-2">
                <input
                  className="w-48 rounded border border-line bg-raised px-2 py-1 text-ink"
                  placeholder="맨홀 번호 (예: 234035)"
                  value={outlet}
                  onChange={(e) => setOutlet(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-ink-muted">이 맨홀로 흘러드는 관을 거슬러 올라가며 모두 가져옵니다. 이 맨홀이 방류구가 됩니다.</p>
              </div>
            )}
            {regionKind === 'all' && <p className="mt-1 text-[11px] text-ink-muted">고른 용도의 관을 전부 가져옵니다. 시 전체는 수만 개라 느릴 수 있습니다.</p>}
            {data.areas.length === 0 && (
              <p className="mt-1 text-[11px] text-ink-muted">처리분구·배수분구(면) .shp 를 함께 고르면 구역별로 가져올 수 있습니다.</p>
            )}
          </section>

          <section className="grid grid-cols-2 gap-3">
            <label>
              <span className="text-[11px] text-ink-muted">이보다 작은 조각 버리기 (관 수)</span>
              <NumberField value={minPipes} min={1} onCommit={setMinPipes} />
            </label>
            <label>
              <span className="text-[11px] text-ink-muted">관경 없는 관 (mm)</span>
              <NumberField value={defaultMm} min={100} onCommit={setDefaultMm} />
            </label>
          </section>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            하수 설계 모듈은 맨홀마다 하류 관이 하나인 수지상 관망을 다룹니다. 분기·순환 관은 큰 관 하나만 남기고 빼며, 만든 뒤 무엇을 뺐는지 알려 드립니다.
            지반고·관저고는 맨홀·관 속성을 쓰고, 빈 값은 토피·이웃 맨홀로 채웁니다.
          </p>
          {data.warnings.length > 0 && (
            <details className="text-[11px] text-ink-muted">
              <summary>읽기 경고 {data.warnings.length}건</summary>
              <ul className="mt-1 list-disc pl-4">
                {data.warnings.slice(0, 30).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}
