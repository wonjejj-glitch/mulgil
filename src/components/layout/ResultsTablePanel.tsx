import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { focusObjects } from '../../app/actions';
import {
  linkColumns,
  linkRows,
  nodeColumns,
  nodeRows,
  tableToCsv,
  timeSeriesCsv,
  type ResultColumn,
} from '../../core/engine/resultsExport';
import { formatClock, formatNumber, isUsUnits } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { baseName, downloadText } from '../../utils/files';
import { Button } from '../ui/fields';

const MAX_ROWS = 400;
type Kind = 'node' | 'link';

interface Row {
  id: string;
  type: string;
  index: number;
}

/** 기준 밖 값: 절점은 수압 부족·과다, 링크는 유속 과다. */
function isProblem(kind: Kind, column: (key: string) => number | undefined, us: boolean): boolean {
  if (kind === 'node') {
    const p = column('pressure');
    return p !== undefined && (p < (us ? 21 : 15) || p > (us ? 100 : 70));
  }
  const v = column('velocity');
  return v !== undefined && v > (us ? 10 : 3);
}

/** 결과 표 탭: 현재 시각의 절점·링크 결과를 정렬·검색하고 CSV 로 내보낸다. */
export function ResultsTablePanel() {
  const model = useNetworkStore((s) => s.model);
  const fileName = useNetworkStore((s) => s.fileName);
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const selection = useUIStore((s) => s.selection);
  const [kind, setKind] = useState<Kind>('node');
  const [query, setQuery] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'id', desc: false });
  const us = isUsUnits(model.options.flowUnits);

  const table = useMemo(() => {
    if (!results) return null;
    const rows: Row[] = kind === 'node' ? nodeRows(model, results) : linkRows(model, results);
    const columns = (kind === 'node' ? nodeColumns(model, results, stepIndex) : linkColumns(model, results, stepIndex)) as ResultColumn<Row>[];
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const value = (row: Row, key: string) => {
      const v = byKey.get(key)?.value(row);
      return typeof v === 'number' ? v : undefined;
    };
    const q = query.trim().toLowerCase();
    let filtered = rows.filter((row) => !q || row.id.toLowerCase().includes(q));
    if (problemsOnly) filtered = filtered.filter((row) => (kind === 'link' || row.type === '절점') && isProblem(kind, (key) => value(row, key), us));
    const sortColumn = byKey.get(sort.key) ?? columns[0];
    const sorted = [...filtered].sort((a, b) => {
      const va = sortColumn.value(a);
      const vb = sortColumn.value(b);
      let cmp: number;
      if (typeof va === 'number' && typeof vb === 'number') {
        // NaN(해당 없음)은 항상 뒤로
        if (Number.isNaN(va)) return 1;
        if (Number.isNaN(vb)) return -1;
        cmp = (sortColumn.key === 'flow' ? Math.abs(va) - Math.abs(vb) : va - vb);
      } else {
        cmp = String(va).localeCompare(String(vb), 'ko', { numeric: true });
      }
      return sort.desc ? -cmp : cmp;
    });
    return { columns, rows: sorted, total: rows.length };
  }, [results, model, kind, stepIndex, query, problemsOnly, sort, us]);

  if (!results || !table) {
    return <div className="flex h-full items-center justify-center text-xs text-ink-muted">해석을 실행하면 절점·관로 결과 표가 여기에 표시됩니다.</div>;
  }

  const base = baseName(fileName ?? 'network');
  const exportCurrent = () =>
    downloadText(`${base}_${kind === 'node' ? '절점' : '링크'}_${formatClock(results.times[stepIndex]).replace(':', '')}.csv`, tableToCsv(table.rows, table.columns), 'text/csv;charset=utf-8');
  const exportSeries = () =>
    downloadText(`${base}_${kind === 'node' ? '절점' : '링크'}_시계열.csv`, timeSeriesCsv(model, results, kind), 'text/csv;charset=utf-8');

  const selectedId = selection && selection.kind === kind ? selection.id : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3 py-1.5 text-xs">
        <div className="flex shrink-0 overflow-hidden rounded border border-line">
          {(['node', 'link'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setSort({ key: 'id', desc: false });
              }}
              className={`px-2.5 py-1 ${kind === k ? 'bg-accent-strong text-white' : 'text-ink-soft hover:bg-raised'}`}
            >
              {k === 'node' ? '절점' : '링크'}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="ID 검색"
          aria-label="ID 검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 w-28 shrink-0 rounded border border-line bg-field px-2 text-xs text-ink outline-none focus:border-accent"
        />
        <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-ink-soft">
          <input type="checkbox" className="accent-accent" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
          {kind === 'node' ? `수압 기준 밖만 (${us ? '21~100 psi' : '15~70 m'})` : `유속 과다만 (${us ? '10 ft/s' : '3 m/s'} 초과)`}
        </label>
        <span className="shrink-0 whitespace-nowrap text-ink-muted">
          {formatClock(results.times[stepIndex])} · {table.rows.length.toLocaleString()} / {table.total.toLocaleString()}개
        </span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button onClick={exportCurrent} title="현재 표(검색·필터 반영)를 CSV 로 저장">
            <Download size={13} />
            현재 시각 CSV
          </Button>
          <Button onClick={exportSeries} title="모든 시간 스텝의 결과를 긴 형식 CSV 로 저장">
            <Download size={13} />
            전체 시계열 CSV
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  className={`cursor-pointer select-none whitespace-nowrap border-b border-line px-2 py-1 font-medium text-ink-soft hover:text-ink ${
                    column.numeric ? 'text-right' : 'text-left'
                  }`}
                  onClick={() => setSort((s) => ({ key: column.key, desc: s.key === column.key ? !s.desc : column.numeric }))}
                >
                  <span className="inline-flex items-center gap-0.5">
                    {column.label}
                    {column.unit && <span className="font-normal text-ink-muted">({column.unit})</span>}
                    {sort.key === column.key && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, MAX_ROWS).map((row) => (
              <tr
                key={row.id}
                onClick={() => {
                  useUIStore.getState().select({ kind, id: row.id });
                  focusObjects(kind === 'node' ? { nodeIds: [row.id], linkIds: [] } : { nodeIds: [], linkIds: [row.id] });
                }}
                className={`cursor-pointer border-b border-line/50 hover:bg-raised ${row.id === selectedId ? 'bg-raised' : ''}`}
              >
                {table.columns.map((column) => {
                  const v = column.value(row);
                  return (
                    <td key={column.key} className={`whitespace-nowrap px-2 py-0.5 ${column.numeric ? 'text-right text-ink' : 'text-left text-ink-soft'}`}>
                      {typeof v === 'number' ? (Number.isNaN(v) ? '—' : formatNumber(v, column.key === 'quality' ? 3 : 2)) : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length > MAX_ROWS && (
          <p className="px-3 py-2 text-[11px] text-ink-muted">
            앞 {MAX_ROWS}개만 표시합니다. 검색·정렬로 좁히거나 CSV 로 내보내 전체를 확인하세요.
          </p>
        )}
      </div>
    </div>
  );
}
