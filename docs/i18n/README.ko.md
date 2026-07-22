<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — 모든 Git 저장소를 지켜보며 당신의 손이 필요한 것을 짚어 주는 로컬 대시보드" />
</p>

# repo-radar

> 365 오픈소스 프로젝트 #027 · 모든 Git 저장소를 지켜보며 그중 어느 것에 당신의 손이 필요한지 알려주는 로컬 대시보드.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

손으로 일일이 챙기기엔 Git 저장소가 너무 많습니다. repo-radar가 그 모두를 지켜보며 지금 당신의 손이 필요한 몇 개만 골라 보여줍니다 — 나머지는 머릿속에서 지워도 됩니다.

그냥 두면 확인하는 걸 잊어버릴 것들을 대신 끄집어냅니다:

- **놓쳐버린 저장소** — 당신이 가진 모든 저장소를 한 화면에, 검색 가능하며, 어느 것이든 클릭 한 번으로 엽니다.
- **끝내지 못한 작업** — 미커밋 · 미푸시 · stash된 변경을 잃어버리기 전에 표시해 줍니다.
- **GitHub가 당신을 기다림** — 모든 저장소에 걸친 열린 PR, 이슈, 실패한 CI를 로컬에 이미 인증된 `gh`를 통해 모아 옵니다.
- **정체되어 가는 프로젝트** — 너무 오래 손대지 않았거나, 출시가 늦어진 것들.

손이 필요한 것들은 큐로서 보드 맨 위로 떠오르며, 긴급도 순으로 정렬되고, 저장소당 한 항목만 — 클릭하면 바로 처리할 수 있습니다. ✓로 지우면 실제로 무언가 바뀌기 전까지 사라진 채로 있고, 기다리는 게 없으면 "all clear"라고 표시됩니다. 나머지 저장소는 언제나 검색 한 번이면 찾을 수 있습니다.

## 설치

[Releases](https://github.com/rockbenben/repo-radar/releases)에서 사용 중인 플랫폼용 파일을 받으세요 — Node.js는 필요 없습니다. 앱은 코드 서명되어 있지 않아 각 OS가 처음 실행할 때 경고를 표시합니다:

- **Windows** — `repo-radar-<version>-x64-setup.exe`를 실행하세요. SmartScreen 프롬프트에서 *추가 정보 → 실행*을 클릭합니다.
- **macOS** — `repo-radar-<version>-arm64.dmg`를 열고 앱을 Applications로 드래그하세요. 처음에는 우클릭 → 열기; macOS가 손상되었다고 하면 `xattr -cr /Applications/repo-radar.app`으로 격리 속성을 한 번 지우세요.
- **Linux** — `chmod +x repo-radar-<version>-x64.AppImage && ./repo-radar-<version>-x64.AppImage`.

또는 소스에서 실행:

```bash
npm install
npm start
```

처음 실행할 때 **스캔 디렉터리 추가**(또는 ⚙ 설정 → 스캔 디렉터리)를 클릭하고 저장소가 들어 있는 폴더를 가리키게 하세요 — JSON도, 재시작도 필요 없이 저장하는 순간 다시 스캔합니다. 직접 편집하고 싶다면 설정은 `~/.repo-radar/config.json`에 있습니다.

## 보드

저장소당 카드 하나 — 상태 색상, 브랜치, 워킹트리 변경 내역, ahead/behind, 마지막 커밋, 태그 — 모든 카드에 클릭 한 번으로 실행하는 **editor / terminal / folder**가 있습니다. 여기서 당신은:

- **찾기** — 검색하고, 언어 / `#tag` / 주의 표시등을 클릭해 필터링하며, 폴더나 언어로 정렬·그룹화합니다. 어떤 필터 + 정렬 + 그룹화든 이름 붙인 뷰로 저장할 수 있습니다. ⌘/Ctrl-K로 런처가 열립니다.
- **일괄 작업** — 저장소를 선택해 fetch / pull(`--ff-only`) / push하거나, 그 저장소들에 걸쳐 셸 명령을 병렬로 실행합니다(dry-run 미리보기와 저장소별 출력 포함). 저장소 하나가 실패해도 나머지는 멈추지 않습니다.
- **저장소 파고들기** — 상세 패널은 전체 상태 내역, 브랜치 전환 / 생성 / 폐기, 실시간 diff와 함께하는 **그 자리에서 커밋**, 필요 시 GitHub PR & CI, 최근 커밋, stash, 12주 히트맵, 그리고 이미 병합된 브랜치를 안전하게 클릭 한 번으로 정리하는 기능을 제공합니다.
- **최신 유지** — 선택적인 파일 감시 자동 스캔과 예약된 백그라운드 fetch, 둘 다 기본값은 꺼짐. 그리고 **Stats** 탭(1년치 커밋 히트맵, 가장 활발한/가장 덜 활발한)과 날짜 범위를 Markdown 주간 보고서로 복사하는 **Worklog** 탭이 있습니다.
- **저장소 생성 및 이동** — **+ New**는 다음 번호 프로젝트를 제안하고 `git init`을 실행하며 README를 작성해 보드에 편입시킵니다. 매니페스트 내보내기 / 가져오기로 설정을 여러 머신 사이에서 옮길 수 있습니다.

UI는 어두운 계기판(instrument-cockpit) 테마의 antd 6이며, 18개 언어로 현지화되어 있습니다(첫 방문 시 브라우저에 자동 매칭, 아랍어는 RTL).

## 백그라운드에서 조용히 실행

창을 닫으면 repo-radar는 트레이로 내려가 파일 감시, 예약된 fetch, GitHub 알림을 계속 실행합니다 — 트레이 아이콘을 클릭하면 보드가 돌아오고, 완전히 종료하려면 트레이 메뉴에서 종료하세요. (데스크톱 트레이를 믿기 어려운 Linux에서는 닫기가 곧 종료입니다. 상주시키려면 로그인 시 시작을 사용하세요.)

⚙ 설정에서 **로그인 시 시작**을 켜면 세션과 함께 창 없이 시작합니다 — 당신이 부를 때까지 창은 나타나지 않습니다. 선택적인 데스크톱 알림은 *새로운* 무언가가 큐에 도착할 때만, 창이 닫혀 있어도 발생합니다. 업그레이드는 의도적으로 수동입니다(자동 업데이트 없음): 새 설치 파일을 기존 것 위에 실행하세요. 로그는 `<config dir>/logs/repo-radar.log`에 남습니다.

## 설정

UI가 건드리는 모든 것은 `~/.repo-radar/config.json`에 저장됩니다 — 열어볼 일은 드뭅니다. 중요한 필드:

| 필드 | 하는 일 |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | 어디를 스캔할지(깊이 6까지 `.git` 탐색), 무엇을 건너뛸지, roots 밖에서 추가한 저장소 |
| `health` | `{ staleDays, disabledRules }` — "stale" 임계값을 조정하거나 개별 검사를 비활성화 |
| `open` | editor / terminal / folder 버튼의 명령 템플릿(`{path}` = 저장소 경로) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | 백그라운드 동작 — 모두 기본값 꺼짐 |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | 저장소별 정리 정보 |

`REPO_RADAR_CONFIG`와 `REPO_RADAR_PORT`(기본 7420)는 설정 경로와 포트를 재정의합니다 — **둘 다** 설정하면 완전히 독립된 두 번째 인스턴스를 실행할 수 있습니다. 서버는 `127.0.0.1`에만 바인딩하고, 모든 API와 WebSocket 요청에서 Origin 헤더를 검증합니다.

## 개발

```bash
npm run dev     # vite + 핫 리로드 되는 앱 창
npm test        # server + web + desktop 테스트 스위트와 타입체크
npm run dist    # dist-electron/ 에 설치 파일 빌드
```

스택: Electron 셸 + Node + Hono(모든 git은 `spawn`을 통해, 네이티브 의존성 없음) + Vite / React 19 / antd 6, 실시간 업데이트를 위한 chokidar + WebSocket. Hono 서버는 Electron의 메인 프로세스 안에서 실행되고 창은 `127.0.0.1`을 통해 그것을 불러오므로, UI는 평범한 HTTP + WebSocket입니다 — 브라우저에서 돌아가는 것과 똑같습니다.

## 365 오픈소스 프로젝트 소개

[365 오픈소스 프로젝트](https://github.com/rockbenben/365opensource)의 **#027**번째 프로젝트 — 한 사람 + AI, 1년에 오픈소스 프로젝트 300개 이상. [아이디어 제안하기 →](https://365.aishort.top/)

## 라이선스

[MIT](../../LICENSE)
