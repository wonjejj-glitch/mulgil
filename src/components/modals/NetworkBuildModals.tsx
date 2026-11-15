/**
 * 대화상자 3종: 수용가 CSV → 관망 초안 / 용도지역 분담유량 / 관망 정리 도구.
 */
import { Crosshair, Download, FileUp, GitMerge, Hash, LoaderCircle, Map as MapIcon, MapPinned, Send, Spline, TriangleExclamationPoint, Wand2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  addFillToNetwork,
  clearRoadFiles,
  loadRoadFiles,
  adoptWaterDraft,
  applyAllocation,
  applyCustomerMapping,
  exportAllocationCsv,
  generateDraft,
  loadCustomerFile,
  loadParcelFiles,
  pickDraftSource,
  previewAllocation,
  runMergeNearby,
  runMergeSeries,
  runRenumber,
  sendSewerDraft,
  setUseKey,
  loadCustomersFromMap,
} from '../../app/draftActions';
import type { ColumnMapping, DemandUnit } from '../../core/io/customerCsv';
import { formatLngLat, type ImportCrsChoice } from '../../utils/geoMath';
import { useDraftStore } from '../../store/useDraftStore';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField, SelectField, TextField } from '../ui/fields';
import { Modal } from '../ui/Modal';

const close = () => useUIStore.getState().openModal(null);

const Note = ({ children, tone }: { children: ReactNode; tone?: 'warn' }) => (
  <p className={`mt-1.5 text-[11px] leading-relaxed ${tone === 'warn' ? 'text-ink' : 'text-ink-muted'}`}>
    {tone === 'warn' && <TriangleExclamationPoint size={12} className="mr-1 inline text-warn" />}
    {children}
  </p>
);

function Field({ label, children, w = 'w-32' }: { label: string; children: ReactNode; w?: string }) {
  return (
    <label className={`block ${w}`}>
      <span className="mb-0.5 block text-[11px] text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function ErrorBox({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mb-3 flex items-start gap-1.5 rounded border border-critical/40 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-ink">
      <TriangleExclamationPoint size={13} className="mt-px shrink-0 text-warn" />
      <span className="break-words">{text}</span>
    </p>
  );
}

const CRS_OPTIONS: { value: ImportCrsChoice; label: string }[] = [
  { value: 'auto', label: '자동 감지' },
  { value: 'wgs84', label: '경위도 (WGS84)' },
  { value: 'EPSG:5186', label: 'EPSG:5186 중부원점' },
  { value: 'EPSG:5185', label: 'EPSG:5185 서부원점' },
  { value: 'EPSG:5187', label: 'EPSG:5187 동부원점' },
  { value: 'EPSG:5181', label: 'EPSG:5181 중부(카카오)' },
  { value: 'EPSG:5174', label: 'EPSG:5174 보정 중부(구)' },
  { value: 'EPSG:5179', label: 'EPSG:5179 UTM-K' },
];

/* ------------------------------------------------------------------ 수용가 → 관망 초안 */

function DraftDialog() {
  const s = useDraftStore();
  const netNodes = useNetworkStore((n) => Object.keys(n.model.nodes).length);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const roadInput = useRef<HTMLInputElement | null>(null);
  const columns = [{ value: '-1', label: '(없음)' }, ...(s.table?.headers.map((h, i) => ({ value: String(i), label: h || `열 ${i + 1}` })) ?? [])];
  const setMap = (patch: Partial<ColumnMapping>) => s.mapping && applyCustomerMapping({ mapping: { ...s.mapping, ...patch } });
  const totalDemand = s.customers.reduce((a, c) => a + c.demand, 0);
  const r = s.result;

  return (
    <Modal
      title="수용가 자료로 관망 초안 만들기"
      onClose={close}
      widthClass="w-[760px]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-muted">도로 자료: OpenStreetMap (영역 경계 좌표만 보냄) · 지반고: 온라인 지형 타일</span>
          <Button onClick={close}>닫기</Button>
        </>
      }
    >
      <ErrorBox text={s.error} />
      <section>
        <h3 className="text-xs font-semibold text-ink">1. 수용가 목록 (CSV)</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button variant={s.table ? 'default' : 'primary'} onClick={() => fileInput.current?.click()}>
            <FileUp size={13} />
            CSV 파일 열기
          </Button>
          <Button disabled={s.busy !== null} onClick={() => void loadCustomersFromMap()} title="수용가 자료가 없을 때: 지금 지도 화면 안의 OpenStreetMap 건물로 개략 수용가를 만듭니다">
            <MapIcon size={13} />
            지도 화면의 건물로 만들기 (개략)
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,.tsv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void loadCustomerFile(f);
            }}
          />
          {s.table && (
            <span className="text-[11px] text-ink-soft">
              {s.fileName} · {s.table.rows.length.toLocaleString()}줄 · {s.table.encoding === 'euc-kr' ? 'EUC-KR' : 'UTF-8'}
            </span>
          )}
        </div>
        <Note>수용가 자료가 없으면 관망을 만들 지역으로 지도를 옮긴 뒤 ‘지도 화면의 건물로 만들기’를 누르세요 — 건물 면적·층수·용도로 세대수를 개략 추정해 수용가로 씁니다(참고용).</Note>
        <Note>요금·급수 대장에서 내려받은 표를 그대로 넣으세요. 열: 수용가 번호, X(경도)·Y(위도) 또는 평면 좌표, 사용량. 엑셀은 ‘CSV(쉼표로 분리)’로 저장합니다. 주소만 있는 자료는 먼저 좌표로 바꿔야 합니다.</Note>
        {s.table && s.mapping && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="ID 열" w="w-28">
              <SelectField value={String(s.mapping.id)} options={columns} onChange={(v) => setMap({ id: Number(v) })} />
            </Field>
            <Field label="X / 경도 열" w="w-28">
              <SelectField value={String(s.mapping.x)} options={columns} onChange={(v) => setMap({ x: Number(v) })} />
            </Field>
            <Field label="Y / 위도 열" w="w-28">
              <SelectField value={String(s.mapping.y)} options={columns} onChange={(v) => setMap({ y: Number(v) })} />
            </Field>
            <Field label="사용량 열" w="w-28">
              <SelectField value={String(s.mapping.demand)} options={columns} onChange={(v) => setMap({ demand: Number(v) })} />
            </Field>
            <Field label="사용량 단위" w="w-28">
              <SelectField<DemandUnit>
                value={s.mapping.demandUnit}
                options={[{ value: 'm3/month', label: 'm³/월' }, { value: 'm3/day', label: 'm³/일' }, { value: 'L/s', label: 'L/s' }]}
                onChange={(v) => setMap({ demandUnit: v })}
              />
            </Field>
            <Field label="좌표계" w="w-40">
              <SelectField value={s.crs} options={CRS_OPTIONS} onChange={(v) => applyCustomerMapping({ crs: v })} />
            </Field>
          </div>
        )}
        {s.customers.length > 0 && (
          <p className="mt-2 text-[11px] text-ink-soft">
            수용가 {s.customers.length.toLocaleString()}곳 · 사용량 합 {totalDemand.toFixed(1)} m³/일 ({(totalDemand / 86.4).toFixed(2)} L/s) · 좌표계 {s.crsLabel}
            {s.skipped.length > 0 && ` · 좌표·사용량을 못 읽은 줄 ${s.skipped.length}개 (${s.skipped.slice(0, 6).join(', ')}${s.skipped.length > 6 ? ' …' : ''})`}
          </p>
        )}
        {s.customers.length > 0 && !s.table && s.busy === null && (
          <Note tone="warn">지도 건물로 만든 개략 수용가입니다(층수·용도가 없는 건물은 기본값). 관망 초안의 관경·유량은 참고용으로만 보세요.</Note>
        )}
        {s.busy === '지도 건물 읽는 중…' && <p className="mt-2 text-[11px] text-ink-soft">지도 건물 읽는 중…</p>}
      </section>

      <section className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-ink">2. 만들 관망과 기준</h3>
        <div className="mt-1.5 flex flex-wrap items-end gap-2">
          <Field label="만드는 방식" w="w-48">
            <SelectField
              value={s.build}
              options={[
                { value: 'new', label: '신규 — 수원부터 새 관망' },
                { value: 'fill', label: `보완 — 지금 관망(절점 ${netNodes.toLocaleString()})에 잇기`, disabled: netNodes === 0 },
              ]}
              onChange={(v) => s.set({ build: v as 'new' | 'fill', result: null, ...(v === 'fill' ? { mode: 'water' as const, maxPipeLength: 300 } : {}) })}
            />
          </Field>
          {s.build === 'fill' && (
            <Field label="이미 공급 중으로 볼 거리 (m)" w="w-44">
              <NumberField value={s.servedDistance} min={1} onCommit={(v) => s.set({ servedDistance: v, result: null })} />
            </Field>
          )}
        </div>
        {s.build === 'fill' && (
          <Note>
            지금 열린 상수 관망의 관로에서 위 거리 안에 있는 수용가는 이미 공급 중으로 보고 건너뜁니다. 나머지(관망이 비어 있는 곳)만 도로를 따라 가장 가까운 기존 절점에 잇고, 새 절점·관만
            추가합니다(기존 관은 바꾸지 않음, Ctrl+Z 로 되돌리기).
          </Note>
        )}
        <div className="mt-1.5 flex flex-wrap items-end gap-2">
          <Field label="종류" w="w-36">
            <SelectField
              value={s.mode}
              options={[{ value: 'water', label: '상수 (배수관망)' }, { value: 'sewer', label: '하수 (오수 관거)', disabled: s.build === 'fill' }]}
              onChange={(v) =>
                s.set({ mode: v as typeof s.mode, maxPipeLength: v === 'sewer' ? 75 : 300, result: null, ...(s.sourceAuto ? { source: null, sourceAuto: false } : {}) })
              }
            />
          </Field>
          <Field label="수용가→도로 최대 거리 (m)" w="w-40">
            <NumberField value={s.maxServiceDistance} min={1} onCommit={(v) => s.set({ maxServiceDistance: v, result: null })} />
          </Field>
          <Field label={s.mode === 'sewer' ? '맨홀 최대 간격 (m)' : '관 최대 길이 (m)'} w="w-36">
            <NumberField value={s.maxPipeLength} min={10} onCommit={(v) => s.set({ maxPipeLength: v, result: null })} />
          </Field>
        </div>
        <div className={`mt-2 flex flex-wrap items-center gap-2 ${s.build === 'fill' ? 'hidden' : ''}`}>
          <Button onClick={pickDraftSource}>
            <Crosshair size={13} />
            지도에서 {s.mode === 'water' ? '수원' : '방류구'} 위치 찍기
          </Button>
          <span className="text-[11px] text-ink-soft">
            {s.source && !s.sourceAuto
              ? `${formatLngLat(s.source)}`
              : `${s.source ? '자동으로 정함' : '지정 안 함'} → ${s.mode === 'water' ? '가장 높은' : '가장 낮은'} 수용가 근처 (초안 만들 때마다 다시 정함)`}
          </span>
          {s.source && (
            <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => s.set({ source: null, sourceAuto: false, result: null })}>
              지우기
            </button>
          )}
        </div>
        {s.mode === 'water' ? (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="첨두계수 (시간최대/일평균)" w="w-40">
              <NumberField value={s.water.peakFactor} min={1} onCommit={(v) => s.set({ water: { ...s.water, peakFactor: v } })} />
            </Field>
            <Field label="관경 결정 유속 (m/s)" w="w-36">
              <NumberField value={s.water.designVelocity} min={0.1} onCommit={(v) => s.set({ water: { ...s.water, designVelocity: v } })} />
            </Field>
            <Field label="최소 관경 (mm)" w="w-28">
              <NumberField value={s.water.minDiameter} min={50} onCommit={(v) => s.set({ water: { ...s.water, minDiameter: v } })} />
            </Field>
            <Field label="조도 C" w="w-20">
              <NumberField value={s.water.roughness} min={1} onCommit={(v) => s.set({ water: { ...s.water, roughness: v } })} />
            </Field>
            <Field label="수원 수위 (지반+m)" w="w-32">
              <NumberField value={s.water.sourceHeadAboveGround} onCommit={(v) => s.set({ water: { ...s.water, sourceHeadAboveGround: v } })} />
            </Field>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="오수 전환율" w="w-28">
              <NumberField value={s.sewer.conversion} min={0} onCommit={(v) => s.set({ sewer: { ...s.sewer, conversion: v } })} />
            </Field>
            <Field label="지하수 침입 비율" w="w-28">
              <NumberField value={s.sewer.infiltration} min={0} onCommit={(v) => s.set({ sewer: { ...s.sewer, infiltration: v } })} />
            </Field>
            <Field label="첨두계수" w="w-24">
              <NumberField value={s.sewer.peakFactor} min={1} onCommit={(v) => s.set({ sewer: { ...s.sewer, peakFactor: v } })} />
            </Field>
            <Field label="방류구 깊이 (m)" w="w-28">
              <NumberField value={s.sewer.outfallDepth} min={0.5} onCommit={(v) => s.set({ sewer: { ...s.sewer, outfallDepth: v } })} />
            </Field>
          </div>
        )}
        <Note tone="warn">첨두계수·유속·전환율 등은 예시값입니다. 사업 기본계획·설계기준 값으로 바꿔 쓰세요.</Note>
      </section>

      <section className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-ink">도로 자료</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button onClick={() => roadInput.current?.click()}>
            <FileUp size={13} />
            도로 중심선 파일 넣기 (.shp·.zip·.geojson)
          </Button>
          <input
            ref={roadInput}
            type="file"
            multiple
            accept=".shp,.dbf,.prj,.cpg,.shx,.zip,.geojson,.json"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void loadRoadFiles(files);
            }}
          />
          <span className="text-[11px] text-ink-soft">{s.roadFile || '없음 → OpenStreetMap 공개 서버에서 받음'}</span>
          {s.roadFile && (
            <button type="button" className="text-[11px] text-accent hover:underline" onClick={clearRoadFiles}>
              지우기
            </button>
          )}
        </div>
        <Note>공개 도로 서버가 바쁘거나 도로가 빠진 곳은 도로명주소 전자지도의 도로구간(도로중심선)이나 수치지도 도로 레이어를 넣으세요. 넣으면 그 자료만 씁니다.</Note>
      </section>

      <section className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-ink">3. 초안 만들기</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={s.customers.length === 0 || s.busy !== null} onClick={() => void generateDraft()}>
            {s.busy ? <LoaderCircle size={13} className="animate-spin" /> : <Wand2 size={13} />}
            초안 만들기
          </Button>
          {s.busy && <span className="text-[11px] text-ink-soft">{s.busy}</span>}
          {r && (
            <>
              <Button onClick={() => close()}>
                <MapPinned size={13} />
                지도에서 미리 보기
              </Button>
              {s.build === 'fill' ? (
                <Button variant="primary" onClick={addFillToNetwork}>
                  <Spline size={13} />
                  지금 관망에 추가
                </Button>
              ) : s.mode === 'water' ? (
                <Button variant="primary" onClick={adoptWaterDraft}>
                  <Spline size={13} />
                  상수 관망으로 열기
                </Button>
              ) : (
                <Button variant="primary" onClick={sendSewerDraft}>
                  <Send size={13} />
                  하수 자동 설계로 보내기
                </Button>
              )}
            </>
          )}
        </div>
        <Note>
          도로 중심선을 따라 수원·방류구에서 각 수용가 접속점까지 가장 짧게 잇는 나무(가지)형 관망을 만듭니다. 하수는 지반고를 보고 오르막을 피하는 경로를 고릅니다. 상수 환상망(루프)·밸브·펌프는 직접
          판단해 더하세요.
        </Note>
        {r && (
          <div className="mt-2 rounded border border-line bg-raised/40 px-3 py-2 text-[11px] text-ink">
            절점 {r.nodes.length.toLocaleString()}개 · 관 {r.links.length.toLocaleString()}개 · 총연장 {(r.stats.totalLength / 1000).toFixed(2)} km · 연결 수용가 {r.stats.served.toLocaleString()} /{' '}
            {r.stats.customers.toLocaleString()} · 공급 {r.stats.servedDemand.toFixed(1)} m³/일
          </div>
        )}
        {s.warnings.map((w, i) => (
          <Note key={i} tone="warn">
            {w}
          </Note>
        ))}
      </section>
    </Modal>
  );
}

export function CustomerDraftModal() {
  const open = useUIStore((s) => s.modal === 'draft');
  return open ? <DraftDialog /> : null;
}

/* ------------------------------------------------------------------ 용도지역 분담유량 */

function AllocateDialog() {
  const s = useDraftStore();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const units = useNetworkStore((n) => n.model.options.flowUnits);
  const scoped = useUIStore((u) => u.multiSelection?.nodeIds.length ?? 0);
  const a = s.allocation;
  const counts = new Map<string, { n: number; area: number }>();
  for (const p of s.parcelsRaw) {
    const use = String(p.props[s.useKey] ?? '(없음)').trim() || '(없음)';
    counts.set(use, { n: (counts.get(use)?.n ?? 0) + 1, area: 0 });
  }
  return (
    <Modal
      title="용도지역 분담유량"
      onClose={close}
      widthClass="w-[720px]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-muted">절점 수요량 = Σ(연결된 용도 구역 면적 × 원단위). 반영은 Ctrl+Z 로 되돌릴 수 있습니다.</span>
          <Button onClick={close}>닫기</Button>
        </>
      }
    >
      <ErrorBox text={s.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={s.parcelsRaw.length ? 'default' : 'primary'} onClick={() => fileInput.current?.click()}>
          <FileUp size={13} />
          용도 구역 열기 (.shp·.zip·.geojson)
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".shp,.dbf,.prj,.cpg,.zip,.geojson,.json"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void loadParcelFiles(files);
          }}
        />
        {s.parcelsRaw.length > 0 && (
          <span className="text-[11px] text-ink-soft">
            {s.parcelFile} · 구역 {s.parcelsRaw.length.toLocaleString()}개
          </span>
        )}
      </div>
      <Note>도시계획 용도지역, 토지이용계획 면 레이어 등. 기존 프로그램처럼 CAD에서 GEO 로 옮길 필요 없이 GIS 파일을 바로 넣습니다.</Note>

      {s.parcelsRaw.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="용도 열" w="w-40">
              <SelectField value={s.useKey} options={s.parcelKeys.map((k) => ({ value: k, label: k }))} onChange={setUseKey} />
            </Field>
            <Field label="연결관 최대 거리 (m)" w="w-36">
              <NumberField value={s.maxConnectDistance} min={1} onCommit={(v) => s.set({ maxConnectDistance: v, allocation: null })} />
            </Field>
          </div>
          <h3 className="mt-3 text-xs font-semibold text-ink">용도별 원단위 (m³/일/ha)</h3>
          <div className="mt-1 max-h-48 overflow-auto rounded border border-line">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">용도</th>
                  <th className="px-2 py-1 text-right font-medium">구역 수</th>
                  <th className="w-32 px-2 py-1 text-right font-medium">원단위</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(s.rates).map((use) => (
                  <tr key={use} className="border-t border-line/50">
                    <td className="px-2 py-0.5 text-ink">{use}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{counts.get(use)?.n ?? 0}</td>
                    <td className="px-1 py-0.5">
                      <NumberField value={s.rates[use]} min={0} onCommit={(v) => s.set({ rates: { ...s.rates, [use]: v }, allocation: null })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Note tone="warn">원단위는 사업 기본계획의 용도별 값을 넣으세요. 0 인 용도는 수요가 생기지 않습니다.</Note>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={previewAllocation}>
              <Wand2 size={13} />
              계산 {scoped > 0 ? `(선택한 절점 ${scoped}개만)` : '(전체 절점)'}
            </Button>
            <Button disabled={!a} onClick={() => applyAllocation('replace')} title="대상 절점의 기본 수요량을 분담유량으로 바꿉니다">
              수요량에 반영 (덮어쓰기)
            </Button>
            <Button disabled={!a} onClick={() => applyAllocation('add')} title="기존 기본 수요량에 더합니다">
              기존 수요량에 더하기
            </Button>
            <Button disabled={!a} onClick={exportAllocationCsv}>
              <Download size={13} />
              분담유량 산출표 CSV
            </Button>
          </div>
          {a && (
            <>
              <p className="mt-2 text-[11px] text-ink">
                면적 {a.totalArea.toFixed(2)} ha · 분담유량 {a.totalFlow.toFixed(1)} m³/일 · 받은 절점 {Object.keys(a.perNode).length}개 · 단위 {units}
                {a.skipped.length > 0 && ` · 제외 구역 ${a.skipped.length}개`}
              </p>
              <div className="mt-1 max-h-48 overflow-auto rounded border border-line">
                <table className="w-full text-[11px] tabular-nums">
                  <thead className="sticky top-0 bg-panel text-ink-soft">
                    <tr>
                      {['구역', '용도', '면적 ha', '원단위', '구역 유량', '연결', '절점', '분담 m³/일'].map((h, i) => (
                        <th key={h} className={`px-1.5 py-1 font-medium ${i < 2 || i === 5 || i === 6 ? 'text-left' : 'text-right'}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {a.rows.slice(0, 500).map((row, i) => (
                      <tr key={i} className="border-t border-line/50">
                        <td className="px-1.5 py-0.5 text-ink">{row.parcel}</td>
                        <td className="px-1.5 py-0.5 text-ink-soft">{row.use}</td>
                        <td className="px-1.5 py-0.5 text-right text-ink-soft">{row.area.toFixed(3)}</td>
                        <td className="px-1.5 py-0.5 text-right text-ink-soft">{row.rate}</td>
                        <td className="px-1.5 py-0.5 text-right text-ink-soft">{row.flow.toFixed(2)}</td>
                        <td className="px-1.5 py-0.5 text-ink-soft">{row.method}</td>
                        <td className="px-1.5 py-0.5 text-ink">{row.node}</td>
                        <td className="px-1.5 py-0.5 text-right text-ink">{row.share.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {a.skipped.length > 0 && <Note tone="warn">제외: {a.skipped.slice(0, 6).map((x) => `${x.parcel}(${x.reason})`).join(', ')}{a.skipped.length > 6 ? ' …' : ''}</Note>}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export function AllocationModal() {
  const open = useUIStore((s) => s.modal === 'allocate');
  return open ? <AllocateDialog /> : null;
}

/* ------------------------------------------------------------------ 관망 정리 도구 */

function ToolsDialog() {
  const multi = useUIStore((s) => s.multiSelection);
  const [tol, setTol] = useState(0.5);
  const [kind, setKind] = useState<'node' | 'link'>('node');
  const [typeFilter, setTypeFilter] = useState('all');
  const [prefix, setPrefix] = useState('J');
  const [digits, setDigits] = useState(3);
  const [start, setStart] = useState(1);
  const [step, setStep] = useState(1);
  const scope = multi ? `선택한 ${kind === 'node' ? `절점 ${multi.nodeIds.length}` : `링크 ${multi.linkIds.length}`}개` : '전체';
  const typeOptions =
    kind === 'node'
      ? [{ value: 'all', label: '모든 절점' }, { value: 'junction', label: '절점(Junction)' }, { value: 'reservoir', label: '수원지' }, { value: 'tank', label: '배수지' }]
      : [{ value: 'all', label: '모든 링크' }, { value: 'pipe', label: '관로' }, { value: 'pump', label: '펌프' }, { value: 'valve', label: '밸브' }];
  const sample = `${prefix}${String(start).padStart(digits, '0')}, ${prefix}${String(start + step).padStart(digits, '0')}, …`;
  return (
    <Modal title="관망 정리 도구" onClose={close} widthClass="w-[560px]" footer={<Button onClick={close}>닫기</Button>}>
      <p className="text-[11px] text-ink-muted">
        대상: {multi ? '구역 선택(A)·Ctrl+클릭으로 고른 객체' : '관망 전체'} — 일부만 처리하려면 먼저 구역 선택을 하세요. 모든 작업은 Ctrl+Z 로 되돌릴 수 있습니다.
      </p>

      <section className="mt-3">
        <h3 className="text-xs font-semibold text-ink">가까운 절점 병합</h3>
        <div className="mt-1.5 flex items-end gap-2">
          <Field label="병합 거리 (m)" w="w-28">
            <NumberField value={tol} min={0.01} onCommit={setTol} />
          </Field>
          <Button onClick={() => runMergeNearby(tol)}>
            <GitMerge size={13} />
            병합
          </Button>
        </div>
        <Note>도면에서 겹쳐 그려진 절점을 하나로 합칩니다. 수원지·배수지가 있으면 그것을 남기고 수요량은 더합니다. 사이에 펌프·밸브가 있으면 합치지 않습니다.</Note>
      </section>

      <section className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-ink">직렬 관로 병합</h3>
        <Button className="mt-1.5" onClick={runMergeSeries}>
          <Spline size={13} />
          같은 제원 관 합치기
        </Button>
        <Note>수요가 0 인 절점에 관경·조도·손실계수·상태가 같은 관 두 개만 이어져 있으면 하나로 합칩니다(형상은 꺾임점으로 남김). 제어 규칙에 쓰인 이름은 건드리지 않습니다.</Note>
      </section>

      <section className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-ink">ID 일괄 재부여</h3>
        <div className="mt-1.5 flex flex-wrap items-end gap-2">
          <Field label="대상" w="w-24">
            <SelectField
              value={kind}
              options={[{ value: 'node', label: '절점' }, { value: 'link', label: '링크' }]}
              onChange={(v) => {
                setKind(v as 'node' | 'link');
                setTypeFilter('all');
                setPrefix(v === 'node' ? 'J' : 'P');
              }}
            />
          </Field>
          <Field label="종류" w="w-32">
            <SelectField value={typeFilter} options={typeOptions} onChange={setTypeFilter} />
          </Field>
          <Field label="접두어" w="w-20">
            <TextField value={prefix} onCommit={(v) => setPrefix(v.trim())} />
          </Field>
          <Field label="자리수" w="w-16">
            <NumberField value={digits} min={1} onCommit={(v) => setDigits(Math.max(1, Math.min(8, Math.round(v))))} />
          </Field>
          <Field label="시작" w="w-16">
            <NumberField value={start} min={0} onCommit={(v) => setStart(Math.round(v))} />
          </Field>
          <Field label="증감" w="w-16">
            <NumberField value={step} min={1} onCommit={(v) => setStep(Math.max(1, Math.round(v)))} />
          </Field>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button onClick={() => runRenumber(kind, { prefix, digits, start, step }, typeFilter)}>
            <Hash size={13} />
            {scope} 재부여
          </Button>
          <span className="text-[11px] text-ink-soft">예: {sample}</span>
        </div>
        <Note>지금 목록 순서대로 번호를 붙입니다. 제어 규칙·수질 등 다른 섹션의 참조도 함께 바뀝니다.</Note>
      </section>
    </Modal>
  );
}

export function NetworkToolsModal() {
  const open = useUIStore((s) => s.modal === 'tools');
  return open ? <ToolsDialog /> : null;
}
