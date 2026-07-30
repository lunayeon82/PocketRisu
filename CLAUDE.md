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

## 완료된 작업
- 코드 스플리팅: Monaco→dynamic import, wasmoon→lazy load, Settings→lazy load, katex/highlight.js→manualChunks 분리
- 채팅 전환 깜빡임 개선: LoadingOverlay→fade 트랜지션, BackgroundDom→캐릭터ID 키 추가, DefaultChatScreen→분기별 transition
- 백업 업로드 수정: Nginx proxy_buffering/proxy_request_buffering off 적용

## 제약 사항
- src/ts 함수 시그니처 변경 시 upstream 호환성 고려
- 채팅 메시지 렌더링 DOM 구조/클래스명 변경 금지 (커스텀 CSS 호환)
- UI 변경은 자유, 단 src/ts 함수 호출은 유지
- pm2 전체 경로 사용: /usr/bin/pm2
- ecosystem.config.cjs (ES module 프로젝트라 .cjs 필수)

## 다음 작업 예정
- 3단계: 서버 인증 게이트 (rl_users, bcrypt, 세션 쿠키)
- 4단계: 공유 로어북 저장소 (비관적 잠금, 개인 사본, 버전 관리)
- 5단계: 채팅 폴더 UI 개선 (옵시디언 스타일)
