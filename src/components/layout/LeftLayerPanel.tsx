import { Eye, EyeOff } from 'lucide-react';
import { VworldKeyLink } from '../ui/DataLinks';
import { useMemo } from 'react';
import { alignNetworkToRoads, reprojectModel } from '../../app/actions';
import { unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore, type LayerVisibility } from '../../store/useUIStore';
import { CRS_DEFS, type ImportCrsChoice } from '../../utils/geoMath';
import { BASEMAP_OPTIONS } from '../map/basemaps';
import { LINK_THEME_OPTIONS, NODE_THEME_OPTIONS } from '../map/thematic';
import { FieldRow, Section, SelectField, TextField } from '../ui/fields';

const CRS_OPTIONS: { value: ImportCrsChoice; label: string }[] = [
  { value: 'auto', label: '자동 감지' },
  { value: 'wgs84', label: 'WGS84 경위도' },
  ...Object.entries(CRS_DEFS).map(([code, def]) => ({ value: code as ImportCrsChoice, label: def.label })),
  { value: 'local', label: '임의 평면 좌표' },
];

function LayerRow({
  layer,
  label,
  count,
  swatch,
}: {
  layer: keyof LayerVisibility;
  label: string;
  count?: number;
  swatch?: string;
}) {
  const visible = useUIStore((s) => s.layers[layer]);
  const toggle = useUIStore((s) => s.toggleLayer);
  return (
    <button
      type="button"
      onClick={() => toggle(layer)}
      aria-pressed={visible}
      className={`flex h-7 w-full items-center gap-2 rounded px-1.5 text-left text-xs transition-colors hover:bg-raised ${
        visible ? 'text-ink' : 'text-ink-muted'
      }`}
    >
      {visible ? <Eye size={14} className="shrink-0 text-ink-soft" /> : <EyeOff size={14} className="shrink-0" />}
      {swatch && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: swatch, opacity: visible ? 1 : 0.4 }} />}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="tabular-nums text-ink-muted">{count.toLocaleString()}</span>}
    </button>
  );
}

/** 좌측 패널: GIS 레이어 트리, 배경지도 선택, 주제도(색상 스케일) 설정. */
export function LeftLayerPanel() {
  const nodes = useNetworkStore((s) => s.model.nodes);
  const links = useNetworkStore((s) => s.model.links);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const hasResults = useSimulationStore((s) => s.results !== null);
  const basemap = useUIStore((s) => s.basemap);
  const basemapDim = useUIStore((s) => s.basemapDim);
  const basemapGray = useUIStore((s) => s.basemapGray);
  const setBasemapLook = useUIStore((s) => s.setBasemapLook);
  const setBasemap = useUIStore((s) => s.setBasemap);
  const vworldKey = useUIStore((s) => s.vworldKey);
  const setVworldKey = useUIStore((s) => s.setVworldKey);
  const nodeTheme = useUIStore((s) => s.nodeTheme);
  const linkTheme = useUIStore((s) => s.linkTheme);
  const setNodeTheme = useUIStore((s) => s.setNodeTheme);
  const setLinkTheme = useUIStore((s) => s.setLinkTheme);
  const model = useNetworkStore((s) => s.model);
  const shift = model.crs.shift;
  const linkCount = Object.keys(model.links).length;
  const importCrs = useUIStore((s) => s.importCrs);
  const setImportCrs = useUIStore((s) => s.setImportCrs);

  const counts = useMemo(() => {
    const result = { junction: 0, source: 0, pipe: 0, device: 0, length: 0 };
    for (const id in nodes) {
      if (nodes[id].type === 'junction') result.junction++;
      else result.source++;
    }
    for (const id in links) {
      const link = links[id];
      if (link.type === 'pipe') {
        result.pipe++;
        result.length += link.length;
      } else result.device++;
    }
    return result;
  }, [nodes, links]);

  const needsKey = BASEMAP_OPTIONS.find((option) => option.id === basemap)?.needsKey ?? false;
  const lengthUnit = unitLabels(flowUnits).length;

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel">
      <Section title="레이어">
        <div className="space-y-0.5">
          <LayerRow layer="junctions" label="절점" count={counts.junction} swatch="#d6deeb" />
          <LayerRow layer="sources" label="수원지·배수지" count={counts.source} swatch="#3987e5" />
          <LayerRow layer="pipes" label="관로" count={counts.pipe} swatch="#6ea0d7" />
          <LayerRow layer="pumpsValves" label="펌프·밸브" count={counts.device} swatch="#fab219" />
          <LayerRow layer="labels" label="절점 ID 라벨" />
          <LayerRow layer="arrows" label="유향 화살표" />
          <LayerRow layer="columns3d" label="3D 수압 기둥" />
        </div>
        <p className="mt-2 text-[11px] text-ink-muted">
          총 관로 연장 {Math.round(counts.length).toLocaleString()} {lengthUnit}
        </p>
      </Section>

      <Section title="주제도 (색상 표시)">
        <FieldRow label="절점">
          <SelectField
            value={nodeTheme}
            onChange={setNodeTheme}
            options={NODE_THEME_OPTIONS.map((option) => ({
              value: option.value,
              label: option.needsResults && !hasResults ? `${option.label} (해석 후)` : option.label,
            }))}
          />
        </FieldRow>
        <FieldRow label="관로">
          <SelectField
            value={linkTheme}
            onChange={setLinkTheme}
            options={LINK_THEME_OPTIONS.map((option) => ({
              value: option.value,
              label: option.needsResults && !hasResults ? `${option.label} (해석 후)` : option.label,
            }))}
          />
        </FieldRow>
        {!hasResults && <p className="mt-2 text-[11px] text-ink-muted">해석을 실행하면 수압·유속 색상과 범례가 지도에 표시됩니다.</p>}
      </Section>

      <Section title="배경지도">
        <div className="space-y-0.5">
          {BASEMAP_OPTIONS.map((option) => (
            <label
              key={option.id}
              className={`flex h-7 cursor-pointer items-center gap-2 rounded px-1.5 text-xs hover:bg-raised ${
                basemap === option.id ? 'text-ink' : 'text-ink-soft'
              }`}
            >
              <input
                type="radio"
                name="basemap"
                className="accent-accent"
                checked={basemap === option.id}
                onChange={() => setBasemap(option.id)}
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))}
        </div>
        {basemap !== 'none' && (
          <div className="mt-2 space-y-1 px-1.5 text-xs text-ink-soft">
            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0">진하기</span>
              <input
                type="range"
                aria-label="배경지도 진하기"
                min={0.1}
                max={1.6}
                step={0.05}
                value={basemapDim}
                onChange={(e) => setBasemapLook({ dim: Number(e.target.value) })}
                className="min-w-0 flex-1 accent-accent"
              />
              <span className="w-9 text-right tabular-nums text-ink-muted">{Math.round(basemapDim * 100)}%</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="accent-accent" checked={basemapGray} onChange={(e) => setBasemapLook({ gray: e.target.checked })} />
              흑백 (관망 색이 잘 보이게)
            </label>
          </div>
        )}
        <div className="mt-2 border-t border-line pt-1.5">
          <LayerRow layer="buildings3d" label="3D 건물" swatch="#8b95a3" />
          <p className="px-1.5 text-[11px] leading-relaxed text-ink-muted">
            지도를 기울여 건물을 세워 보여 줍니다. 가까이 확대하면 브이월드 건물 자료의 층수 × 3.3 m 로 세우고, 키가 없으면 OpenStreetMap 건물을 씁니다. 오른쪽 단추로 끌면 돌려 볼 수 있습니다.
          </p>
        </div>
        {needsKey && (
          <div className="mt-2">
            <FieldRow label="인증키">
              <TextField value={vworldKey} placeholder="브이월드 API 키" onCommit={(value) => setVworldKey(value)} />
            </FieldRow>
            {!vworldKey && (
              <p className="mt-1 text-[11px] text-ink-muted">
                브이월드(vworld.kr) 오픈API 인증키를 입력하면 배경지도가 표시됩니다. 키는 이 브라우저에만 저장됩니다.
                <VworldKeyLink />
              </p>
            )}
          </div>
        )}
      </Section>

      <Section title="가져오기 좌표계">
        <SelectField value={importCrs} onChange={setImportCrs} options={CRS_OPTIONS} />
        <p className="mt-2 text-[11px] text-ink-muted">
          .inp 파일을 열 때 적용합니다. 중부원점 계열(5186·5181·5174·2097)과 서부·동부 원점은 좌표 범위가 겹쳐 자동 감지로 구분할 수 없습니다. 위치가 어긋나면 아래 ‘도로에 맞춰 자동 보정’을 누르면 맞는 좌표계를 찾아 줍니다.
        </p>
        <button
          type="button"
          disabled={importCrs === 'auto' || importCrs === 'local' || model.crs.kind === 'local'}
          title="파일을 다시 열지 않고 지금 열려 있는 관망의 좌표계를 위 선택값으로 바꿔 위치를 다시 계산합니다 (Ctrl+Z 로 되돌리기)"
          onClick={() => reprojectModel(importCrs)}
          className="mt-2 w-full rounded border border-line bg-raised px-2 py-1.5 text-xs text-ink transition-colors hover:border-line-strong hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          열린 관망에 지금 적용
        </button>
      </Section>

      <Section title="위치·표고 보정">
        <button
          type="button"
          disabled={linkCount < 3}
          title="좌표계가 헷갈리거나 관망 전체가 한쪽으로 밀렸을 때: 도로와 가장 잘 맞는 좌표계·평행 이동을 찾습니다 (Ctrl+Z 로 되돌리기)"
          onClick={() => void alignNetworkToRoads()}
          className="w-full rounded border border-line bg-raised px-2 py-1.5 text-xs text-ink transition-colors hover:border-line-strong hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          ① 좌표계·전체 밀림 자동 보정
        </button>
        <button
          type="button"
          disabled={linkCount < 1}
          title="절점을 도로 위로 옮기고 관로를 도로를 따라 다시 그리거나, 지형 자료로 절점 표고를 보정합니다"
          onClick={() => useUIStore.getState().openModal('correction')}
          className="mt-1.5 w-full rounded border border-line bg-raised px-2 py-1.5 text-xs text-ink transition-colors hover:border-line-strong hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          ② 도로 따라 관로 맞추기 · 표고 보정…
        </button>
        {shift && (
          <p className="mt-1.5 text-[11px] tabular-nums text-ink-soft">
            적용된 이동: {shift[0] >= 0 ? '동' : '서'} {Math.abs(shift[0]).toFixed(1)} m, {shift[1] >= 0 ? '북' : '남'} {Math.abs(shift[1]).toFixed(1)} m
          </p>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
          ① 은 관망 전체를 한꺼번에 옮깁니다(좌표계 선택·평행 이동, .inp 원본 좌표 유지). ② 는 절점·관로를 하나하나 도로에 맞추고, 지형 자료로 표고를 바꿉니다. 먼저 ①, 그다음 ② 순서를 권합니다. 도로 자료는 브이월드 수치지도 도로중심선(안 되면 OpenStreetMap)에서 받고, 보내는 정보는 관망 영역의 경계 좌표뿐입니다.
        </p>
      </Section>
    </aside>
  );
}
