# 보배반점 직영점 매출 조회 (클라우드 스케줄용)

메타포스(홀)+푸드테크(배달) 매출을 조회해 슬랙 보고에 쓰는 스크립트.
계정은 환경변수(METAPOS_ID/PW, FTK_ID/PW/BRAND)로 주입 — 이 저장소에는 계정이 없습니다.
외부 npm 패키지 없이 node 내장 fetch만 사용.

    METAPOS_ID=.. METAPOS_PW=.. FTK_ID=.. FTK_PW=.. FTK_BRAND=.. node scripts/sales-slack.mjs --json
