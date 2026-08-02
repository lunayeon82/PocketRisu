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
- 캐릭터 카드(로어북/프리셋/설정 포함)는 계정별로 분리되지 않음 — 배포 전체가 database.bin 하나를 공유 (server.cjs의 /api/read|write|patch에 rl_auth 유저 스코핑 없음, checkAuth는 RisuAI 자체 JWT로 rl_auth와 무관). 채팅·채팅폴더는 rl_chats/rl_chat_folders로, 공유 로어북은 rl_lorebooks 계열로 각각 별도 계정별/스코프별 분리됨 (아래 4단계 참고) — database.bin 자체는 여전히 미분리

## 완료된 작업
- 코드 스플리팅: Monaco→dynamic import, wasmoon→lazy load, Settings→lazy load, katex/highlight.js→manualChunks 분리
- 채팅 전환 깜빡임 개선: LoadingOverlay→fade 트랜지션, BackgroundDom→캐릭터ID 키 추가, DefaultChatScreen→분기별 transition
- 백업 업로드 수정: Nginx proxy_buffering/proxy_request_buffering off 적용
- 3단계: 서버 인증 게이트 (rl_users, bcrypt, rl_auth 세션 쿠키, authGate.cjs)
- 5단계: 채팅 폴더 UI 개선 (옵시디언 스타일) — chatTree.ts로 폴더/채팅 트리 구성, ChatTreeItem.svelte로 재귀 렌더링(접기/펼치기, 이름변경, 색상, 삭제 시 자식 승격), MoveToFolderModal.svelte로 컨텍스트 메뉴 이동, 드래그 앤 드롭(같은 종류끼리 순서 변경, 폴더로 이동, 최상위 드롭존, 최대 깊이 2 및 자기 자신 하위 이동 가드) — reorderChats/updateChatFolder API 사용
- 단일 캐릭터 자동 진입 (autoOpenSingleCharacter 설정) — 켜면 부팅 시 캐릭터 갤러리 건너뛰고 첫 번째(휴지통 제외) 캐릭터 채팅으로 바로 진입, 사이드바 캐릭터 추가(+) 버튼도 숨김. bootstrap.ts에서 처리
- 사이드바 "최근에 본" 목록 버그 수정 — Sidebar.svelte의 recentChars가 trashTime(휴지통) 필터링을 안 해서, 삭제(소프트 삭제) 캐릭터가 메인 그리드에서는 사라져도 최근 목록엔 3일 뒤 자동 정리 전까지 계속 표시되던 문제
- 4단계: 공유 로어북 저장소 (lorebookApi.cjs) + 캐릭터 globalLore 연결 — 현재 상태:
  - 서버 스코프/잠금/버전 로직: rl_lorebooks.scope('global'/'private')+owner_id. global은 전체 공개, private은 owner_id 본인만 조회/편집(canView()로 404 처리). private→global(to-global)은 단방향. global→private 복제(clone)는 entry id 전체 재발급으로 원본과 완전 분리. 삭제는 global=관리자만/private=소유자만. 잠금은 책이 아니라 **항목(entry) 단위**(rl_lorebook_locks/rl_lorebook_drafts) — **만료 없음**(비관적 락, 같은 유저 재요청은 갱신, 다른 유저는 저장/취소 전까지 계속 409). 실제 내용 편집(PUT .../entries/:entryId)만 잠금 필요, 추가/삭제/순서변경/이름변경은 잠금 불필요. 버전 스냅샷(최근 3개, rl_lorebook_versions)은 책 전체 단위, 잠금 무관. entry_id는 모든 쓰기 경로에서 backfillEntryIds()로 채움. rl_lorebook_overrides 테이블은 서버에 남아있지만 **클라이언트에서 더 이상 안 씀**(죽은 경로) — 활성화 모드는 이제 순전히 로컬(아래 참고)
  - 별도 목록/편집 화면(SharedLoreBookStore.svelte, lorebookDraftDb.ts)은 삭제됨 — 공유 저장소는 순수 "발행/구독" 채널이고, 편집은 항상 캐릭터 자신의 로어북 화면(LoreBookData.svelte)에서만 함
  - 연결: loreBook에 source_lorebook_id/source_updated_at 추가. 로어 항목 1개 = 공유 로어북 1개(entry-level, content:[그 항목]) 대응. sharedLorebookLink.svelte.ts가 업로드(uploadEntryToSharedLorebook, 잠금→저장)/동기화(syncEntriesFromSharedLorebook, 받아오기·업데이트·버전복원이 공용으로 씀)를 담당 — 동기화는 콘텐츠는 서버 값으로 교체하되 alwaysActive/disabled(활성화 방식)는 항상 로컬 값을 보존
  - 백그라운드 동기화: LoreBookSetting.svelte가 Character 탭이 열려있는 동안 15초 폴링(startBackgroundSync/stopBackgroundSync)으로 "아직 안 가져온 새 글로벌 책"/"연결된 항목의 원본이 갱신됨"을 감지해 로어북 화면 상단에 배너("받아오기" 버튼 하나)로 표시, 클릭 시 일괄 반영하고 결과(신규 n건/업데이트 n건)를 토스트로 알림
  - **중요: character.globalLore는 계정별로 분리되지 않는다** (위 아키텍처 항목 참고 — database.bin 전체가 배포 공유, ~500ms 디바운스로 자동저장). 그래서 편집 중인 내용을 절대로 `value`(캐릭터의 globalLore 항목)에 직접 써서는 안 됨 — 그 순간 자동저장을 타고 배포 전체에 미공개 수정본이 broadcast됨. 편집: source_lorebook_id가 있는 항목은 LoreBookData.svelte에서 기본 읽기전용 — "편집 시작"(pencil)이 서버 잠금(POST .../lock, rl_lorebook_locks, entry 단위, **TTL 없음**·비관적 락)을 쥐어야만 편집 가능해지는데, 이때 실제 입력은 `value`가 아니라 별도 로컬 상태 `editDraft`(LoreBookData.svelte)에 반영됨 — `value`는 항상 마지막으로 알려진 canonical 콘텐츠만 들고 있음. `editDraft`는 잠금 응답이 준 내용(canonical 사본 또는 이 유저 본인이 예전에 남긴 draft)으로 시작하고, 타이핑하는 동안 600ms 디바운스로 `PUT .../entries/:entryId/draft`(rl_lorebook_drafts, **유저별로 진짜 분리됨**)에 계속 저장되어 새로고침해도 "편집 시작"을 다시 누르면 이어서 편집 가능. **잠금은 단일 소유자 배타적**(I/O 독점과 동일 원리)이라 한 명이 쥐고 있는 동안 다른 사람은 편집 시작 자체가 409로 막힘. 잠금 해제는 "업로드" 성공(서버 saveEntry가 draft+lock 자동 삭제) 또는 "편집 취소"(DELETE .../lock, **draft도 같이 삭제되므로 작성 중이던 내용은 사라짐** — 확인창 있음) 둘 중 하나뿐. "업로드" 버튼은 연결 안 된 항목(신규 등록)이거나 지금 편집 중(editingShared)인 연결된 항목에만 뜸 — 업로드 시 확인창("기존 공유 로어북 'OO'을 덮어씁니다") 후 uploadEntryToSharedLorebook(target, content, existing)이 content(=편집 중이면 editDraft, 아니면 value 자신)를 업로드하고 잠금 획득+저장을 원자적으로 수행, 성공 시 그 내용을 target(=value)에도 복사해 업로더 본인 화면에도 즉시 반영. "공유" 뱃지 옆 "미업로드" 뱃지는 editingShared 여부로만 표시(콘텐츠 diff 비교 없음 — value가 절대 안 바뀌므로 필요 없음). 받아오기(syncEntriesFromSharedLorebook)는 이제 항상 무조건 덮어써도 안전 — value가 WIP을 들고 있는 경우가 없으므로 스킵/force 로직 불필요. 버전 기록/복원 버튼은 여기 있음
  - 활성화 방식은 3택(상시/키워드트리거/비활성) — loreBook.disabled 필드 추가, loadLoreBookV3Prompt에서 disabled 항목은 프롬프트 조립에서 제외. 순전히 개인 설정이라 서버로 안 올라가고(동기화 시 보존됨, 위 참고) 항상 로컬에서만 관리
  - 외부 JSON 재import(importLoreBook, risu 포맷)는 source_lorebook_id/source_updated_at를 항상 벗겨내고 개인 상태로 저장 — 공유 링크가 파일 경유로 의도치 않게 따라붙는 것 방지
  - 미구현: 항목 순서 변경 API(PATCH .../entries/reorder)는 서버에 있지만 드래그 UI는 아직 없음
- 채팅 저장 동시성 보호 — PUT /api/chats/:id/full(upsertChatFull)이 버전 체크 없이 그 채팅의 메시지를 통째로 delete+reinsert하는 구조라, 같은 계정을 두 군데(탭 2개/PC+휴대폰)에서 동시에 같은 채팅에 저장하면 나중 요청이 먼저 요청의 메시지를 조용히 지울 수 있었음. body에 optional `expected_updated_at`을 추가해 기존 행의 updated_at과 다르면 409(덮어쓰지 않음)로 거부 — 클라이언트(nodeStorage.ts)는 chatUpdatedAtCache(모듈 전역 Map)로 채팅별 마지막 known updated_at을 들고 있다가 매 저장 시 실어보내고, 서버 응답/409의 updated_at으로 갱신. 충돌 시 saveChatToServer가 ChatConflictError를 던지고, globalApi.svelte.ts의 저장 루프는 그 채팅 저장만 건너뜀(로컬 메모리는 안 건드림 — 다음 실제 편집 때 다시 시도됨) — 절대 "누구 걸 지울지 자동으로 고르지" 않음. **의도적으로 안 한 것**: server.cjs의 activeSessionId 단일-writer 423 락(database.bin용)을 chatApi.cjs에도 적용하는 건 잘못된 방향 — 그건 배포 전체에 "한 세션만 쓰기 허용"이라 계정이 다른 두 유저가 각자 자기 채팅만 써도 서로를 423으로 튕겨냄(채팅은 원래 계정별로 완전히 분리돼 있는데 그 격리를 오히려 깨버림). 좁은 동시-편집 레이스에는 위 버전체크가 맞는 해법.
- 채팅/폴더 트리 UX 개선 — 이름변경을 인라인 입력 대신 ShDialog 모달로 분리(행이 draggable이라 인라인 입력 드래그 시 텍스트 선택이 행 드래그로 오인식되던 문제 해결), 뎁스별 세로 가이드라인으로 폴더 소속 명시, 드래그 중 "어디로 이동하는지" 설명 배너 추가, 최상위 드롭존을 드래그 중에만 노출되는 라벨 있는 큰 영역으로 개선, ondragend로 드롭존 상태 항상 리셋
  - 터치 기기 드래그 미지원(HTML5 DnD가 터치 스크롤과 충돌해서 isTouchDevice면 draggable 자체를 꺼둠) — grip 핸들 꾹 눌러 pointer 이벤트 기반 커스텀 드래그로 보완 예정, 아직 미착수

## 제약 사항
- src/ts 함수 시그니처 변경 시 upstream 호환성 고려
- 채팅 메시지 렌더링 DOM 구조/클래스명 변경 금지 (커스텀 CSS 호환)
- UI 변경은 자유, 단 src/ts 함수 호출은 유지
- pm2 전체 경로 사용: /usr/bin/pm2
- ecosystem.config.cjs (ES module 프로젝트라 .cjs 필수)
- upstream의 서버 사이드 생성 기능을 cherry-pick할 경우, 서버 완성 경로가 chatApi.cjs의 upsertChatFull()도 호출하는지 반드시 확인할 것 (미호출 시 서버 생성 메시지가 rl_chats에 반영되지 않아 클라이언트 재접속 후 덮어씌워질 수 있음)
