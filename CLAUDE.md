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
- 채팅/폴더 트리 grip 핸들 추가 (ChatTreeItem.svelte/SideChatList.svelte) — 터치 기기 드래그 미지원 문제 해결
  - 각 행 왼쪽에 GripVerticalIcon 핸들: PC는 hover 시에만 보임(`group-hover:opacity-100`), 터치는 항상 보임
  - PC: `draggable`은 여전히 행 전체에 걸려있음 — 핸들 하나에만 `draggable`을 걸면 일부 브라우저 엔진에서 네이티브 `dragstart` 자체가 안 터지는 문제가 있어서 포기(실측: dispatchEvent로 강제 발동하면 정상 동작 → 핸들러는 멀쩡, 브라우저가 안 쏘는 것). 대신 행에 `onmousedown`을 걸어 눌린 지점이 핸들(`data-drag-handle`) 안인지를 `dragOriginatedOnHandle` 플래그로 기록해두고, `ondragstart`에서는 그 플래그만 검사해서 핸들 밖에서 시작된 드래그는 `preventDefault()`로 취소. **`ondragstart` 시점의 `e.target`으로 직접 검사하면 안 됨** — 드래그가 draggable 조상의 자식에서 시작돼도 네이티브 `dragstart`의 `e.target`은 실제로 눌린 요소가 아니라 draggable 조상 자신(행)으로 귀결되므로, `e.target.closest('[data-drag-handle]')`는 자식 방향인 핸들을 절대 못 찾음(`closest`는 조상 방향만 훑음) — 반드시 `mousedown` 시점(그때는 `e.target`이 진짜 눌린 요소)에 판정해서 플래그로 넘겨야 함
  - 터치: 핸들의 `pointerdown`에서 300ms longpress 판정(10px 초과 이동 시 스크롤로 간주해 취소) → `setPointerCapture`로 이후 이벤트를 핸들에 고정 → `pointermove`마다 `document.elementFromPoint`+`data-chat-tree-row`/`data-chat-tree-root-drop` 속성으로 직접 hit-test(`resolveDropTargetAtPoint`, 네이티브 dragover가 없어서 직접 구현) → `pointerup`에서 기존 `onDropOn`/`onDropRoot`를 그대로 호출. `touch-action: none`(Tailwind `touch-none`)은 핸들에 항상 거는 게 아니라 `isTouchDevice`일 때만 — PC에서까지 걸려있으면 네이티브 드래그 미발동의 원인 후보 중 하나였음(다른 원인으로 확인됐지만 안전하게 조건부로 유지)
  - 드롭존 하이라이트(`dropZone`)는 각 행이 로컬 `$state`로 들고 있던 걸 SideChatList의 공유 `hoverTarget` state에서 `$derived`로 파생하는 방식으로 전환 — 터치 드래그는 시작한 행과 다른 행 위를 hover할 수 있어서(포인터 캡처가 다른 인스턴스의 상태를 못 건드림) 공유 state가 필요했음. 네이티브 dragover와 터치 hit-test 둘 다 같은 `onHoverChange`/`onHoverClear` 콜백을 거치므로 하이라이트 로직은 하나만 존재
  - 기존 `onDropOn`/`onDropRoot`/`reorderChats`/`persistChatOrder`/깊이 가드 로직은 전혀 안 건드림 — PC 네이티브 드래그와 터치 커스텀 드래그가 최종적으로 같은 함수를 호출하도록만 연결
- 채팅 순서·폴더 소속 버그 2건 수정 (chatApi.cjs, nodeStorage.ts)
  - 새 채팅이 화면에선 맨 위인데 재접속하면 맨 아래로 밀리던 문제 — 새 채팅 생성 코드들(6곳)이 로컬 배열엔 `unshift`로 맨 앞에 넣지만, 서버(`upsertChatFull`의 INSERT 분기)는 `nextPosition()`(= 기존 채팅 중 최댓값+1, 즉 맨 뒤)으로 저장하고 있었음 → position=0으로 삽입하고 같은 스코프(user_id+character_id+folder_id)의 기존 행들 position을 전부 +1 시프트하도록 수정. 생성 코드 6곳은 안 건드림(서버만 클라이언트 쪽 unshift 가정에 맞춤)
  - 드래그로 폴더 이동한 채팅이 재로드 후 가끔 폴더 밖으로 빠져나오던 문제 — `folder_id`가 서버에 컬럼과 `chat_meta` JSON 두 군데에 중복 저장되는데, 드래그 이동(`PATCH /reorder`, `/meta`)은 컬럼만 갱신하고 `chat_meta`는 그대로 둠. 채팅을 다시 열 때(`fetchChatContent`)는 `chat_meta.folderId`(stale할 수 있음)만 읽고 있었어서, 열람 시점에 옛 폴더 값으로 되돌아갔다가 다음 자동저장에 그 값이 다시 영구 반영되던 것 — 응답 최상위의 `folder_id` 컬럼(항상 최신)을 우선하도록 수정
- 채팅 트리 grip 핸들 — PC 네이티브 드래그가 아예 안 먹던 버그 + 그 수정이 만든 터치 회귀 + 재발한 폴더/순서 리셋 버그, 3건 연쇄 수정
  - **PC: grab 커서는 뜨는데 실제 드래그가 시작 안 됨** — `dragstart`→`dragend`가 5ms 만에 연속 발화하고 그 사이에 `dragover`가 단 한 번도 안 뜨는 걸 이벤트 리스너로 확인(`document.querySelectorAll('[data-chat-tree-row]')`의 Y좌표를 dragstart/dragend 시점마다 찍어봄). 원인: `SideChatList.svelte`의 `onDragStart()`가 `isDragging = true`를 동기적으로 세팅 → `{#if isDragging}` 배너 `<div>`가 리스트 컨테이너 **위에 in-flow로** 마운트되며 아래 행들이 28px 밀려 내려감 → 네이티브 HTML5 DnD는 드래그 소스의 레이아웃 박스가 dragstart 직후 움직이면 그 자리에서 드래그를 취소하는 스펙이라, Chrome이 `dragover` 한 번 못 띄우고 드래그를 죽여버림(개발자도구에는 아무 에러도 안 남아서 원인 추적이 까다로움) — grip 핸들 커밋과 "드래그 중 설명 배너" 커밋이 시점이 겹치며 생긴 회귀로 추정. 수정: 배너를 리스트 위 zero-height `<div class="relative">` 앵커 안에 `absolute` + `z-10`으로 오버레이시켜서, 마운트/언마운트가 리스트의 실제 레이아웃을 절대 안 건드리게 함
  - **위 수정이 만든 터치 회귀** — 배너가 이제 `z-10`으로 리스트 맨 위 행 위에 시각적으로 겹치는데, 터치 드래그(`resolveDropTargetAtPoint`)는 네이티브 `dragover`가 없어서 `document.elementFromPoint(x, y)`로 손가락 아래 요소를 직접 hit-test함 — 배너가 그 좌표에서 실제 행보다 위에 있으니 hit-test가 배너 자신을 집어서 `.closest('[data-chat-tree-row]')`가 null이 되고, 리스트 맨 위 근처로 드롭할 때만 조용히 아무 일도 안 일어남(에러도 안 남음). 배너에 `pointer-events-none` 추가해서 hit-test를 통과하도록 수정 — 배너는 순수 정보 표시용이라 애초에 hit 대상이 될 이유가 없었음
  - **재발한 "새로고침하면 채팅 위치/폴더가 원래대로 되돌아간다" 버그** — 5단계 때 고쳤던 클라이언트 읽기 경로(`fetchChatContent`가 `chat_meta.folderId` 대신 top-level `folder_id` 컬럼을 우선하도록 한 것) 자체는 여전히 멀쩡했음(boot/`loadChatListFromServer`도 전부 컬럼 소스 확인됨). 실제 원인은 **쓰기 경로의 레이스**: `upsertChatFull`(전체 채팅 자동저장, `PUT .../full`)이 기존 채팅을 업데이트할 때마다 클라이언트가 보낸 `chat_meta.folderId`로 `folder_id` 컬럼을 매번 덮어썼음. 근데 드래그 정렬/폴더 이동이 쓰는 `reorderChats`(`PATCH /reorder`)와 `patchChatMeta`(`PATCH .../meta`)는 **의도적으로 `updated_at`을 안 건드림**(정렬 좀 했다고 최근순 정렬에서 맨 위로 튀는 게 이상해서) — 그래서 `upsertChatFull`의 낙관적 동시성 체크(`expected_updated_at`)가 "그 사이에 리오더가 있었다"는 걸 절대 감지 못 함. 메시지 많은 채팅이라 자동저장 요청이 느리게 나가는 동안(특히 모바일 네트워크) 사용자가 드래그로 폴더 이동을 하면: 리오더가 먼저 도착해서 컬럼을 정확히 갱신 → 뒤늦게 도착한 자동저장이 드래그 이전 시점의 `chat_meta.folderId`로 다시 컬럼을 덮어씀 → 새로고침하면 아까 그 되돌려진 값이 그대로 보임. 수정: `updateChat`/`upsertChatFull`은 **기존 채팅에 한해** `chat_meta.folderId`를 절대 안 읽고 DB에 있던 `folder_id`를 그대로 보존하도록 변경 — 폴더 배정은 이제 전적으로 `reorderChats`/`patchChatMeta` 전담. 새 채팅 생성(INSERT 분기)만 예외적으로 여전히 `chat_meta.folderId`를 씀(가져오기·브랜치처럼 처음부터 폴더 안에 만드는 게 정당한 유일한 케이스라서)
  - 위 수정의 부작용으로 `Chat.svelte`의 "브랜치" 기능(`createFolderOnBranch` 설정)이 깨질 뻔한 걸 발견 — 브랜치 시 새 폴더를 만드는 코드가 `createChatFolder` API를 아예 호출 안 하고 로컬 `chara.chatFolders`에만 push한 뒤 현재 채팅의 `folderId`를 로컬로만 바꾸고 다음 자동저장(`chat_meta`)에 얹혀 서버로 가길 기대하고 있었음 — 위 수정이 들어가면 그 자동저장이 더 이상 folder_id를 안 옮기니 폴더 배정이 영원히 서버에 안 감. `createChatFolder` + `updateChatMeta`를 명시적으로 호출하도록 수정
  - **검증**: 실제 레이스를 API 레벨로 직접 재현(리오더 먼저 도착 → 그 다음 구버전 `chat_meta.folderId`를 담은 `PUT .../full` 도착) → 수정 전이면 폴더 밖으로 튕겨났을 상황에서 폴더 안에 정상 유지되는 것 확인, 새로고침 후에도 유지
  - **아직 안 고친 것(같은 계열의 별개 레이스, 후속 필요)**: 새 채팅 생성 직후(서버 INSERT가 아직 안 끝난 시점) 다른 채팅을 드래그해서 정렬하면, `persistChatOrder`가 그 스코프의 형제 전부(아직 서버에 없는 그 새 채팅 id 포함)를 하나의 배치로 묶어 `reorderChats`에 보내는데, 서버가 "id 전부가 이 유저 소유여야 함"을 배치 단위로 검사하다 보니 아직 존재 안 하는 id 하나 때문에 배치 전체가 404로 조용히 실패함 — "새로 만든 채팅 위치가 새로고침하면 바뀐다" 증상이 이걸로 설명될 가능성 있음. 아직 미수정

## 제약 사항
- src/ts 함수 시그니처 변경 시 upstream 호환성 고려
- 채팅 메시지 렌더링 DOM 구조/클래스명 변경 금지 (커스텀 CSS 호환)
- UI 변경은 자유, 단 src/ts 함수 호출은 유지
- pm2 전체 경로 사용: /usr/bin/pm2
- ecosystem.config.cjs (ES module 프로젝트라 .cjs 필수)
- upstream의 서버 사이드 생성 기능을 cherry-pick할 경우, 서버 완성 경로가 chatApi.cjs의 upsertChatFull()도 호출하는지 반드시 확인할 것 (미호출 시 서버 생성 메시지가 rl_chats에 반영되지 않아 클라이언트 재접속 후 덮어씌워질 수 있음)
