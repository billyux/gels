import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// 국민재난안전포털(safekorea.go.kr)의 시설안전지도가 내부적으로 쓰는
// 공개 엔드포인트입니다. 로그인/인증키 없이 접근 가능합니다.
const SOURCE_URL = "https://www.safekorea.go.kr/safekorea-kor/flsm/flsm/facilityDataList.do";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  // 기본값: 부산진구(26230)
  const sggCd = url.searchParams.get("sggCd") || "26230";

  try {
    const res = await fetch(SOURCE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": "https://www.safekorea.go.kr/safekorea-kor/flsm/flsm/facilitiesSafteyMap.do?menuSn=2&baseMapNm=naver",
      },
      body: `tableNm=TFK_HTW_RSTR_TEMP&tableKorNm=${encodeURIComponent("무더위쉼터")}&sggCd=${sggCd}&page=1&size=1000`,
    });

    const data = await res.json();

    const shelters = (data.mapList || [])
      .filter((s: any) => s.la && s.lo)
      .map((s: any) => ({
        name: s.rstrNm,
        address: s.rnDtlAdres,
        lat: s.la,
        lng: s.lo,
        capacity: s.usePsblNmpr,
        aircon: s.chckMatterAirconPosesAt === "Y",
        nightOpen: s.chckMatterNightOpnAt === "Y",
      }));

    return new Response(JSON.stringify({ shelters }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
