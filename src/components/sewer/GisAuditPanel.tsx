/** 하수 도크 '자료 점검' 탭: 하수도 GIS 에서 만든 관망의 채움·변경·제외·확인 필요 목록. */
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { focusSewerObject } from '../../app/sewerMapActions';
import { useSewerGisStore } from '../../store/useSewerGisStore';
import { useSewerStore } from '../../store/useSewerStore';
import { downloadText } from '../../utils/files';
import { Button } from '../ui/fields';

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function GisAuditPanel() {
  const audit = useSewerGisStore((s) => s.audit);
  const projectName = useSewerStore((s) => s.project.name);
  const [issue, setIssue] = useState('');

  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of audit?.notes ?? []) m.set(n.issue, (m.get(n.issue) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [audit]);
  const rows = useMemo(() => (audit?.notes ?? []).filter((n) => !issue || n.issue === issue), [audit, issue]);

  if (!audit) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-ink-muted">
        파일 → ‘하수도 GIS(SHP)에서 관망 만들기’로 만든 관망의 자료 점검 목록이 여기 나옵니다. 수치지형도를 함께 넣으면 지반고가 지형과 크게 다른 맨홀도 찾아 줍니다.
      </div>
    );
  }
  const stale = audit.projectName !== projectName;
  const exportCsv = () => {
    const lines = ['구분,ID,항목,내용,관망에서 뺌', ...audit.notes.map((n) => [n.kind === 'node' ? '맨홀' : '관거', n.id, n.issue, n.detail, n.removed ? '예' : ''].map(csvCell).join(','))];
    downloadText(`${audit.projectName.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 40)}_자료점검.csv`, String.fromCharCode(0xfeff) + lines.join('\n'), 'text/csv;charset=utf-8');
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-2 text-xs">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <select className="rounded border border-line bg-raised px-2 py-1 text-ink" value={issue} onChange={(e) => setIssue(e.target.value)}>
          <option value="">전체 {audit.notes.length.toLocaleString()}건</option>
          {groups.map(([name, count]) => (
            <option key={name} value={name}>
              {name} {count.toLocaleString()}
            </option>
          ))}
        </select>
        <Button onClick={exportCsv}>
          <Download size={12} /> CSV
        </Button>
        <span className="truncate text-[11px] text-ink-muted">
          {audit.terrainLabel || '지형 자료 없이 만듦 — 수치지형도를 넣으면 지반고도 점검합니다.'}
          {stale && ' · 지금 관망은 이 목록을 만든 관망과 이름이 다릅니다.'}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-line">
        <table className="w-full">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-ink-muted">
            <tr>
              <th className="whitespace-nowrap px-2 py-1">구분</th>
              <th className="whitespace-nowrap px-2 py-1">ID</th>
              <th className="whitespace-nowrap px-2 py-1">항목</th>
              <th className="px-2 py-1">내용</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 2000).map((n, i) => (
              <tr key={`${n.id}-${i}`} className={`border-t border-line/60 ${n.removed ? 'text-ink-muted' : 'cursor-pointer hover:bg-raised'}`} onClick={() => !n.removed && focusSewerObject({ kind: n.kind, id: n.id })}>
                <td className="whitespace-nowrap px-2 py-0.5">{n.kind === 'node' ? '맨홀' : '관거'}</td>
                <td className="whitespace-nowrap px-2 py-0.5 text-ink">{n.id}</td>
                <td className="whitespace-nowrap px-2 py-0.5">{n.issue}</td>
                <td className="px-2 py-0.5 text-ink-soft">
                  {n.detail}
                  {n.removed && ' (관망에 없음)'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 2000 && <p className="p-2 text-[11px] text-ink-muted">앞 2,000건만 보입니다. 전체는 CSV 로 받으세요.</p>}
      </div>
    </div>
  );
}
