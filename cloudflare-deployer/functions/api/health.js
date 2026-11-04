import { checkWorkerHealth } from "../../src/deployer-core.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function onRequestPost({ request }) {
  try {
    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > 12 * 1024) return json({ success: false, error: "حجم درخواست بیش از حد مجاز است." }, 413);
    let raw = "";
    if (request.body) {
      const reader = request.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 12 * 1024) {
          try { await reader.cancel(); } catch {}
          return json({ success: false, error: "حجم درخواست بیش از حد مجاز است." }, 413);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      raw = new TextDecoder().decode(bytes);
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { return json({ success: false, error: "بدنه درخواست JSON معتبر نیست." }, 400); }

    const result = await checkWorkerHealth(payload);
    return json(result, 200);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    return json({ success: false, error: error?.message || "خطای ناشناخته در بررسی سلامت Worker." }, status);
  }
}
