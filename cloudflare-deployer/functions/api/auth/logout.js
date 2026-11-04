import { json, requireDb, destroySession, enforceSameOrigin } from "../../_lib/shared.js";
export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const cookie = await destroySession(request, requireDb(env));
    return json({ success: true }, 200, { "Set-Cookie": cookie });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
