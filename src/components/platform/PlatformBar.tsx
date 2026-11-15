/**
 * '물마루' 플랫폼 공통 상단바 (물길·가람·물꼬 공통 규격). 높이 40px, 기존 툴바 위에 놓인다.
 * 스타일은 src/index.css 의 .mulmaru-* 클래스(규격 색·글꼴·좁은 화면·인쇄 숨김).
 */
const PORTAL = 'https://wonjejj-glitch.github.io/mulmaru/';

const APPS = [
  { id: 'mulgil', name: '물길', desc: '관망해석', href: 'https://wonjejj-glitch.github.io/mulgil/' },
  { id: 'garam', name: '가람', desc: '댐 용수공급', href: 'https://wonjejj-glitch.github.io/garam/' },
  { id: 'mulkko', name: '물꼬', desc: '하수관로 정비', href: 'https://wonjejj-glitch.github.io/mulkko/' },
] as const;

export function PlatformBar({ current = 'mulgil' }: { current?: (typeof APPS)[number]['id'] }) {
  return (
    <nav className="mulmaru-bar" aria-label="물마루 플랫폼">
      <a className="mulmaru-brand" href={PORTAL} title="물마루 포털">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 15.5c2.6 0 3.9-1.7 5.3-4.5C8.8 8 10.2 4.8 12 4.8s3.2 3.2 4.7 6.2c1.4 2.8 2.7 4.5 5.3 4.5" fill="none" stroke="#5cc98d" strokeWidth="2.3" strokeLinecap="round" />
          <path d="M2 19.5c2 0 3-1 5-1s3 1 5 1 3-1 5-1 3 1 5 1" fill="none" stroke="#ecf6f0" strokeWidth="1.6" strokeLinecap="round" opacity=".7" />
        </svg>
        물마루
      </a>
      <span className="mulmaru-divider" aria-hidden="true" />
      <ul className="mulmaru-menu">
        {APPS.map((app) => (
          <li key={app.id}>
            <a className="mulmaru-item" href={app.href} aria-current={app.id === current ? 'page' : undefined}>
              {app.name}
              <span className="mulmaru-desc">{app.desc}</span>
            </a>
          </li>
        ))}
      </ul>
      <a className="mulmaru-portal" href={PORTAL}>
        포털
      </a>
    </nav>
  );
}
