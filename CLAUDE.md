# PocketRisu 프로젝트 컨텍스트

RisuAI 포크. upstream 자동 머지 안 함. 필요 시 src/ts 변경분만 수동 cherry-pick.

## 배포 환경
- AWS Lightsail (서울, 1GB RAM, Ubuntu 24.04)
- Nginx 리버스 프록시 (서브도메인 risu.lunayeon.com → PM2 앱)
- PM2 프로세스 관리 (/usr/bin/pm2)
- SQLite: better-sqlite3, ~/oc-yeonsung/server/data/shared.db
  - 다른 앱(oc-yeonsung)과 공유, 테이블 접두사 rl_
- R2: @aws-sdk/client-s3, img.lunayeon.com
- GitHub Actions 자동 배포 (push → SSH → git pull → pnpm build → pm2 restart)

## 아키텍처
- 3-엔트리 반MPA: index.html, settings.html, chat.html (각각 별도 Vite 엔트리)
- 각 엔트리 안에서는 전역 Svelte store로 뷰 스위칭 (라우터 없음)
- 로컬 퍼스트: 채팅 데이터는 각 사용자 브라우저 IndexedDB에 저장
- 서버 저장 모드: 채팅을 placeholder로 부팅 → 처음 열 때 hydration
- 캐릭터 카드(로어북/프리셋/설정 포함)는 계정별로 분리되지 않음 — 배포 전체가 database.bin 하나를 공유 (server.cjs의 /api/read|write|patch에 rl_auth 유저 스코핑 없음, checkAuth는 RisuAI 자체 JWT로 rl_auth와 무관). 반면 채팅·채팅폴더는 rl_chats/rl_chat_folders로 계정별 분리됨 — 4단계(공유 로어북 저장소) 작업 시 이 갭을 참고할 것

## 완료된 작업
- 코드 스플리팅: Monaco→dynamic import, wasmoon→lazy load, Settings→lazy load, katex/highlight.js→manualChunks 분리
- 채팅 전환 깜빡임 개선: LoadingOverlay→fade 트랜지션, BackgroundDom→캐릭터ID 키 추가, DefaultChatScreen→분기별 transition
- 백업 업로드 수정: Nginx proxy_buffering/proxy_request_buffering off 적용
- 3단계: 서버 인증 게이트 (rl_users, bcrypt, rl_auth 세션 쿠키, authGate.cjs)
- 5단계: 채팅 폴더 UI 개선 (옵시디언 스타일) — chatTree.ts로 폴더/채팅 트리 구성, ChatTreeItem.svelte로 재귀 렌더링(접기/펼치기, 이름변경, 색상, 삭제 시 자식 승격), MoveToFolderModal.svelte로 컨텍스트 메뉴 이동, 드래그 앤 드롭(같은 종류끼리 순서 변경, 폴더로 이동, 최상위 드롭존, 최대 깊이 2 및 자기 자신 하위 이동 가드) — reorderChats/updateChatFolder API 사용
- 단일 캐릭터 자동 진입 (autoOpenSingleCharacter 설정) — 켜면 부팅 시 캐릭터 갤러리 건너뛰고 첫 번째(휴지통 제외) 캐릭터 채팅으로 바로 진입, 사이드바 캐릭터 추가(+) 버튼도 숨김. bootstrap.ts에서 처리
- 사이드바 "최근에 본" 목록 버그 수정 — Sidebar.svelte의 recentChars가 trashTime(휴지통) 필터링을 안 해서, 삭제(소프트 삭제) 캐릭터가 메인 그리드에서는 사라져도 최근 목록엔 3일 뒤 자동 정리 전까지 계속 표시되던 문제
- 4단계: 공유 로어북 저장소 — rl_lorebooks/rl_lorebook_versions/rl_lorebook_locks/rl_lorebook_drafts (lorebookApi.cjs), 비관적 잠금(1시간 타임아웃, 만료 시 draft는 보존하고 lock만 해제 — 재잠금 시 자기 draft 우선 사용) + 개인 사본 + 최근 3버전 관리. 클라이언트는 LoreBookSetting.svelte 툴바에 진입점(LibraryBigIcon), SharedLoreBookStore.svelte가 목록/잠금배지/새버전뱃지(15초 폴링)/편집(LoreBookList 재사용)/버전복원 담당, 임시저장은 lorebookDraftDb.ts(순수 IndexedDB)에만
- 채팅/폴더 트리 UX 개선 — 이름변경을 인라인 입력 대신 ShDialog 모달로 분리(행이 draggable이라 인라인 입력 드래그 시 텍스트 선택이 행 드래그로 오인식되던 문제 해결), 뎁스별 세로 가이드라인으로 폴더 소속 명시, 드래그 중 "어디로 이동하는지" 설명 배너 추가, 최상위 드롭존을 드래그 중에만 노출되는 라벨 있는 큰 영역으로 개선, ondragend로 드롭존 상태 항상 리셋

## 제약 사항
- src/ts 함수 시그니처 변경 시 upstream 호환성 고려
- 채팅 메시지 렌더링 DOM 구조/클래스명 변경 금지 (커스텀 CSS 호환)
- UI 변경은 자유, 단 src/ts 함수 호출은 유지
- pm2 전체 경로 사용: /usr/bin/pm2
- ecosystem.config.cjs (ES module 프로젝트라 .cjs 필수)
- upstream의 서버 사이드 생성 기능을 cherry-pick할 경우, 서버 완성 경로가 chatApi.cjs의 upsertChatFull()도 호출하는지 반드시 확인할 것 (미호출 시 서버 생성 메시지가 rl_chats에 반영되지 않아 클라이언트 재접속 후 덮어씌워질 수 있음)
